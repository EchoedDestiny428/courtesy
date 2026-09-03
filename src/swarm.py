"""
Courtesy Multi-Node Autonomous Agent Swarm Engine
Coordinates a fast 7B Leader model and dual 14B Worker models across the cluster
to continuously iterate on complex programming tasks until completion.
"""

import asyncio
import json
import logging
import os
import socket
import time
import uuid
from typing import Dict, Any, List, Optional, Callable

import httpx

from src.config import get_servers
from src.collector import get_cached_metrics
from src.web_agent import generate_grounded_context
from src.router import track_request_start, track_request_end
from src.miner_manager import record_inference_start

logger = logging.getLogger("courtesy.swarm")

IS_ON_CST = socket.gethostname().lower() in ("cst", "cst.local") or os.path.exists("/opt/courtesy")

# In-memory active swarm tasks
_active_swarms: Dict[str, Dict[str, Any]] = {}
_swarm_subscribers: List[asyncio.Queue] = []


def get_swarm_nodes() -> Dict[str, Any]:
    """
    Selects 1x 7B node for Leader and 2x 14B nodes for Workers from online servers.
    """
    servers = [s for s in get_servers() if s.get("enabled", True) and s.get("type") == "ollama"]
    metrics = get_cached_metrics()

    online_servers = []
    for s in servers:
        s_id = s["id"]
        m = metrics.get(s_id, {})
        if m.get("online", True): # Default to true if configured
            online_servers.append(s)

    if not online_servers:
        raise RuntimeError("No online compute nodes found for swarm.")

    # Sort nodes
    node_7b = None
    nodes_14b = []

    for s in online_servers:
        models = [m.get("name", "") for m in s.get("models", [])]
        if any("7b" in m for m in models) and not node_7b:
            node_7b = s
        if any("14b" in m for m in models):
            nodes_14b.append(s)

    # Fallbacks if exact separation is not met
    if not node_7b:
        node_7b = online_servers[0]
    if len(nodes_14b) < 2:
        # Re-use available nodes
        while len(nodes_14b) < 2:
            for s in online_servers:
                if s not in nodes_14b or len(nodes_14b) < 2:
                    nodes_14b.append(s)
                if len(nodes_14b) >= 2:
                    break

    return {
        "leader": {"server": node_7b, "model": "qwen2.5-coder:7b"},
        "worker_1": {"server": nodes_14b[0], "model": "qwen2.5-coder:14b"},
        "worker_2": {"server": nodes_14b[1] if len(nodes_14b) > 1 else nodes_14b[0], "model": "qwen2.5-coder:14b"}
    }


async def call_node_inference(server: Dict[str, Any], model: str, system_prompt: str, user_prompt: str, max_tokens: int = 2048) -> str:
    """Executes chat completion on a specific node, automatically using LAN or Gateway route."""
    s_id = server.get("id")
    host = server.get("host", "127.0.0.1")
    port = server.get("port", 11434)

    record_inference_start()
    await track_request_start(s_id)
    
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            # If running on cst, we can reach 10.11.2.x directly via HTTP
            if IS_ON_CST:
                try:
                    native_payload = {
                        "model": model,
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt}
                        ],
                        "stream": False,
                        "options": {
                            "temperature": 0.2,
                            "num_predict": max_tokens
                        }
                    }
                    resp = await client.post(f"http://{host}:{port}/api/chat", json=native_payload)
                    if resp.status_code == 200:
                        data = resp.json()
                        return data.get("message", {}).get("content", "")
                except Exception as e:
                    logger.debug(f"Direct error on {s_id}: {e}")

            # If outside subnet (e.g. from Windows) or fallback, route via Pi Gateway
            gateway_url = "http://100.107.249.92:8000/v1/chat/completions"
            v1_payload = {
                "model": f"{s_id}/{model}",
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                "temperature": 0.2,
                "max_tokens": max_tokens,
                "stream": False
            }
            resp = await client.post(gateway_url, json=v1_payload)
            if resp.status_code == 200:
                data = resp.json()
                return data["choices"][0]["message"]["content"]
            else:
                raise RuntimeError(f"Swarm inference error on {s_id} ({resp.status_code}): {resp.text}")
    finally:
        await track_request_end(s_id)


async def broadcast_swarm_event(event: Dict[str, Any]):
    """Broadcasts live swarm step events to all listening WebSocket queues."""
    dead_queues = []
    for q in _swarm_subscribers:
        try:
            q.put_nowait(event)
        except Exception:
            dead_queues.append(q)
    for dq in dead_queues:
        if dq in _swarm_subscribers:
            _swarm_subscribers.remove(dq)


def register_swarm_subscriber() -> asyncio.Queue:
    q = asyncio.Queue()
    _swarm_subscribers.append(q)
    return q


def unregister_swarm_subscriber(q: asyncio.Queue):
    if q in _swarm_subscribers:
        _swarm_subscribers.remove(q)


async def execute_swarm_workflow(task_id: str, objective: str, max_iterations: int = 4):
    """
    Core autonomous multi-agent execution loop:
    1. 7B Leader grounds objective with web docs & breaks down tasks.
    2. 14B Worker 1 implements core architecture and functions.
    3. 14B Worker 2 audits code, analyzes edge cases, and writes tests.
    4. 7B Leader verifies criteria and either finishes or triggers next iteration.
    """
    task = _active_swarms[task_id]
    task["status"] = "running"

    try:
        nodes = get_swarm_nodes()
        leader_node = nodes["leader"]["server"]
        leader_model = nodes["leader"]["model"]
        w1_node = nodes["worker_1"]["server"]
        w1_model = nodes["worker_1"]["model"]
        w2_node = nodes["worker_2"]["server"]
        w2_model = nodes["worker_2"]["model"]

        await broadcast_swarm_event({
            "task_id": task_id,
            "type": "init",
            "message": "Swarm initialized across 3 cluster nodes.",
            "leader": f"{leader_node['id']} ({leader_model})",
            "worker_1": f"{w1_node['id']} ({w1_model})",
            "worker_2": f"{w2_node['id']} ({w2_model})"
        })

        # Phase 0: Web Grounding & Documentation Lookup
        await broadcast_swarm_event({
            "task_id": task_id,
            "type": "step",
            "role": "Researcher",
            "node": leader_node["id"],
            "content": f"Searching live internet and documentation for: '{objective}'"
        })
        web_context, sources = await generate_grounded_context(objective, force=False)
        sources_msg = f"Retrieved {len(sources)} modern documentation references." if sources else "No external search required."
        
        await broadcast_swarm_event({
            "task_id": task_id,
            "type": "step",
            "role": "Researcher",
            "node": leader_node["id"],
            "content": sources_msg,
            "sources": sources
        })

        current_code = ""
        current_tests = ""
        current_plan = ""

        for iteration in range(1, max_iterations + 1):
            if task.get("cancelled", False):
                break

            await broadcast_swarm_event({
                "task_id": task_id,
                "type": "iteration_start",
                "iteration": iteration,
                "max_iterations": max_iterations
            })

            # --- Step 1: 7B Leader Planning & Delegation ---
            leader_sys = (
                "You are the Swarm Leader & Chief Software Architect. You coordinate two 14B AI engineer nodes. "
                "Your job: break down the objective into actionable technical milestones, specify strict interface types, "
                "and define acceptance criteria. Be concise, direct, and technically rigorous."
            )
            leader_prompt = f"""
OBJECTIVE: {objective}
ITERATION: {iteration} of {max_iterations}

CURRENT CODE:
{current_code or '(None yet. Fresh project)'}

CURRENT TESTS / AUDIT:
{current_tests or '(None yet)'}

LIVE DOCUMENTATION CONTEXT:
{web_context or '(Pretrained knowledge)'}

Provide:
1. Architectural Blueprint & Component Decomposition
2. Task for Worker 1 (Core Implementation & Logic)
3. Task for Worker 2 (Verification, Security, & Unit Tests)
4. Evaluation: If the current code and tests are 100% complete and bug-free, end with: [ALL_TASKS_COMPLETE]
"""
            await broadcast_swarm_event({
                "task_id": task_id,
                "type": "agent_thinking",
                "role": "Leader (7B)",
                "node": leader_node["id"],
                "model": leader_model,
                "step_name": f"Iteration {iteration}: Decomposing Architecture"
            })

            current_plan = await call_node_inference(leader_node, leader_model, leader_sys, leader_prompt, max_tokens=1500)
            
            await broadcast_swarm_event({
                "task_id": task_id,
                "type": "agent_message",
                "role": "Leader (7B)",
                "node": leader_node["id"],
                "model": leader_model,
                "content": current_plan
            })

            if "[ALL_TASKS_COMPLETE]" in current_plan and current_code:
                await broadcast_swarm_event({
                    "task_id": task_id,
                    "type": "step",
                    "role": "Leader (7B)",
                    "node": leader_node["id"],
                    "content": "All acceptance criteria met. Swarm task completed successfully!"
                })
                break

            if task.get("cancelled", False):
                break

            # --- Step 2: 14B Worker 1 (Lead Implementer) ---
            w1_sys = (
                "You are Worker 1, an Elite 14B Software Engineer. Your role is implementing production-grade, "
                "clean, complete, and type-safe code based on the Leader's plan. Output complete code in markdown blocks."
            )
            w1_prompt = f"""
OBJECTIVE: {objective}
ARCHITECTURAL PLAN:
{current_plan}

EXISTING CODE TO UPDATE OR EXTEND:
{current_code or '(Initial generation)'}

Implement the required code completely. Do not use placeholders or omit methods.
"""
            await broadcast_swarm_event({
                "task_id": task_id,
                "type": "agent_thinking",
                "role": "Worker 1 (14B Implementer)",
                "node": w1_node["id"],
                "model": w1_model,
                "step_name": f"Iteration {iteration}: Coding Primary Subsystem"
            })

            current_code = await call_node_inference(w1_node, w1_model, w1_sys, w1_prompt, max_tokens=3000)

            await broadcast_swarm_event({
                "task_id": task_id,
                "type": "agent_message",
                "role": "Worker 1 (14B Implementer)",
                "node": w1_node["id"],
                "model": w1_model,
                "content": current_code
            })

            if task.get("cancelled", False):
                break

            # --- Step 3: 14B Worker 2 (Auditor & Test Engineer) ---
            w2_sys = (
                "You are Worker 2, a Senior 14B QA & Test Automation Specialist. Your role is auditing Worker 1's code "
                "for bugs, memory/concurrency leaks, race conditions, edge cases, and writing an exhaustive test suite."
            )
            w2_prompt = f"""
OBJECTIVE: {objective}
CODE PRODUCED BY WORKER 1:
{current_code}

Review the code thoroughly:
1. List any logical flaws, edge case failures, or performance bottlenecks.
2. Write comprehensive unit tests and mocks verifying all methods.
"""
            await broadcast_swarm_event({
                "task_id": task_id,
                "type": "agent_thinking",
                "role": "Worker 2 (14B Auditor)",
                "node": w2_node["id"],
                "model": w2_model,
                "step_name": f"Iteration {iteration}: Bug Audit & Test Suite Generation"
            })

            current_tests = await call_node_inference(w2_node, w2_model, w2_sys, w2_prompt, max_tokens=2500)

            await broadcast_swarm_event({
                "task_id": task_id,
                "type": "agent_message",
                "role": "Worker 2 (14B Auditor)",
                "node": w2_node["id"],
                "model": w2_model,
                "content": current_tests
            })

        # Final Assembly
        task["status"] = "completed" if not task.get("cancelled") else "cancelled"
        task["final_code"] = current_code
        task["final_tests"] = current_tests

        await broadcast_swarm_event({
            "task_id": task_id,
            "type": "completed",
            "status": task["status"],
            "final_code": current_code,
            "final_tests": current_tests
        })

    except Exception as e:
        logger.error(f"Swarm task {task_id} failed: {e}", exc_info=True)
        task["status"] = "failed"
        task["error"] = str(e)
        await broadcast_swarm_event({
            "task_id": task_id,
            "type": "error",
            "error": str(e)
        })


def start_swarm_task(objective: str, max_iterations: int = 3) -> str:
    """Creates and starts a background swarm task."""
    task_id = str(uuid.uuid4())[:8]
    _active_swarms[task_id] = {
        "id": task_id,
        "objective": objective,
        "status": "pending",
        "start_time": time.time(),
        "cancelled": False,
        "final_code": "",
        "final_tests": ""
    }
    asyncio.create_task(execute_swarm_workflow(task_id, objective, max_iterations))
    return task_id


def stop_swarm_task(task_id: str) -> bool:
    """Cancels a running swarm task."""
    if task_id in _active_swarms:
        _active_swarms[task_id]["cancelled"] = True
        _active_swarms[task_id]["status"] = "cancelled"
        return True
    return False


def get_swarm_status(task_id: str) -> Optional[Dict[str, Any]]:
    return _active_swarms.get(task_id)
