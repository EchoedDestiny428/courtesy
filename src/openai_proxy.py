import asyncio
import json
import logging
import os
import socket
import time
from typing import Dict, Any, List, Optional, AsyncGenerator
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
import httpx

from src.router import resolve_route, track_request_start, track_request_end, RouteTarget, ensure_vram_headroom
from src.collector import get_cached_metrics
from src.config import get_servers

logger = logging.getLogger("courtesy.proxy")
router = APIRouter()

IS_ON_CST = socket.gethostname().lower() in ("cst", "cst.local") or os.path.exists("/opt/courtesy")


@router.get("/v1/models")
async def list_openai_models():
    """
    Returns OpenAI-compatible model catalog aggregating models across all active cluster servers.
    Includes aliases for seamless drop-in replacement with VS Code, Cline, Continue.dev, etc.
    """
    metrics = get_cached_metrics()
    servers = get_servers()
    
    models_list = [
        {"id": "auto", "object": "model", "owned_by": "courtesy-cluster"},
        {"id": "codex", "object": "model", "owned_by": "courtesy-cluster"},
        {"id": "claude-3-5-sonnet", "object": "model", "owned_by": "courtesy-cluster"},
        {"id": "qwen2.5-coder", "object": "model", "owned_by": "courtesy-cluster"}
    ]

    seen = set(m["id"] for m in models_list)

    # Add specific models found on servers
    for s in servers:
        s_id = s.get("id")
        s_metric = metrics.get(s_id, {})
        for m in s_metric.get("models", []):
            m_name = m.get("name")
            if m_name and m_name not in seen:
                models_list.append({
                    "id": m_name,
                    "object": "model",
                    "owned_by": s_id,
                    "details": m
                })
                seen.add(m_name)
            
            # Scoped name: e.g. "kraken/qwen2.5-coder:7b"
            scoped_name = f"{s_id}/{m_name}"
            if scoped_name not in seen:
                models_list.append({
                    "id": scoped_name,
                    "object": "model",
                    "owned_by": s_id
                })
                seen.add(scoped_name)

    return {"object": "list", "data": models_list}


async def stream_ollama_openai(target: RouteTarget, payload: Dict[str, Any]) -> AsyncGenerator[str, None]:
    """Streams completions from Ollama native or OpenAI-compatible endpoint with SSE formatting."""
    await track_request_start(target.server_id)
    endpoint = f"{target.base_url}/v1/chat/completions"
    
    # Clone and sanitize payload
    req_payload = payload.copy()
    req_payload["model"] = target.model_name
    req_payload["stream"] = True

    try:
        # First attempt: direct HTTP streaming
        can_direct = True
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                await ensure_vram_headroom(target, client)
                async with client.stream("POST", endpoint, json=req_payload) as resp:
                    if resp.status_code == 200:
                        async for chunk in resp.aiter_text():
                            yield chunk
                        can_direct = False # Successfully completed
                    else:
                        can_direct = True
        except Exception:
            can_direct = True

        # If direct HTTP cannot reach the LAN node (e.g. from outside subnet), proxy through cst gateway
        if can_direct:
            json_input = json.dumps(req_payload)
            if IS_ON_CST:
                cmd = ["curl", "-s", "-N", "-H", "Content-Type: application/json", endpoint, "-d", "@-"]
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
            else:
                curl_cmd = f"curl -s -N -H 'Content-Type: application/json' {endpoint} -d @-"
                proc = await asyncio.create_subprocess_exec(
                    "ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", "cst@cst",
                    curl_cmd,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
            
            # Write body and close stdin
            if proc.stdin:
                proc.stdin.write(json_input.encode("utf-8"))
                await proc.stdin.drain()
                proc.stdin.close()

            # Stream chunks from stdout
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                yield line.decode("utf-8", errors="ignore")
                
            await proc.wait()

    except Exception as e:
        logger.error(f"Streaming error on {target.server_id}: {e}")
        err_chunk = {
            "error": {
                "message": f"Cluster error on {target.server_name}: {str(e)}",
                "type": "server_error"
            }
        }
        yield f"data: {json.dumps(err_chunk)}\n\ndata: [DONE]\n\n"
    finally:
        await track_request_end(target.server_id)


@router.post("/v1/chat/completions")
async def chat_completions(request: Request):
    """
    OpenAI-compatible Chat Completions endpoint.
    Compatible with VS Code (Continue / Cline / Roo Code / Copilot alternatives) & Courtesy GUI.
    """
    body = await request.json()
    model_req = body.get("model", "auto")
    stream = body.get("stream", False)
    
    try:
        target = resolve_route(model_query=model_req)
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))

    logger.info(f"Routing request for '{model_req}' -> {target.server_id} ({target.server_name}) using '{target.model_name}'")

    if stream:
        return StreamingResponse(
            stream_ollama_openai(target, body),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Courtesy-Server": target.server_id,
                "X-Courtesy-Model": target.model_name
            }
        )

    # Non-streaming request
    await track_request_start(target.server_id)
    endpoint = f"{target.base_url}/v1/chat/completions"
    req_payload = body.copy()
    req_payload["model"] = target.model_name
    req_payload["stream"] = False

    try:
        # Direct HTTP attempt
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(endpoint, json=req_payload)
                if resp.status_code == 200:
                    data = resp.json()
                    return JSONResponse(content=data, headers={
                        "X-Courtesy-Server": target.server_id,
                        "X-Courtesy-Model": target.model_name
                    })
        except Exception:
            pass

        # Fallback via cst gateway
        json_input = json.dumps(req_payload)
        if IS_ON_CST:
            cmd = ["curl", "-s", "-H", "Content-Type: application/json", endpoint, "-d", "@-"]
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
        else:
            curl_cmd = f"curl -s -H 'Content-Type: application/json' {endpoint} -d @-"
            proc = await asyncio.create_subprocess_exec(
                "ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", "cst@cst",
                curl_cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
        stdout, _ = await proc.communicate(input=json_input.encode("utf-8"))
        res_data = json.loads(stdout.decode("utf-8"))
        return JSONResponse(content=res_data, headers={
            "X-Courtesy-Server": target.server_id,
            "X-Courtesy-Model": target.model_name
        })

    except Exception as e:
        logger.error(f"Inference error on {target.server_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Inference failed on {target.server_name}: {str(e)}")
    finally:
        await track_request_end(target.server_id)
