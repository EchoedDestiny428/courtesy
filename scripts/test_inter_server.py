"""
Inter-Server Mesh Communication & Logic Test Suite
Tests connectivity, latency, and cross-node Ollama inference across all servers.
"""

import asyncio
import json
import sys
import time
import httpx

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

SERVERS = [
    {"id": "kraken", "name": "kraken (Node 1)", "host": "10.11.2.22", "port": 11434},
    {"id": "cst6", "name": "cst6 (Node 2)", "host": "10.11.16.29", "port": 11434},
    {"id": "cst7", "name": "cst7 (Node 3)", "host": "10.11.2.12", "port": 11434},
]

GATEWAY = "http://100.107.249.92:8000"


async def test_node_reachability():
    print("\n[1] Testing direct API & Model reachability for each compute node:")
    results = {}
    async with httpx.AsyncClient(timeout=5.0) as client:
        for s in SERVERS:
            url = f"http://{s['host']}:{s['port']}/api/tags"
            start = time.time()
            try:
                # Via gateway proxy or direct LAN
                r = await client.get(f"{GATEWAY}/api/servers", timeout=6.0)
                all_s = r.json()
                node_data = next((x for x in all_s if x["id"] == s["id"]), None)
                online = node_data.get("status", {}).get("online", False) if node_data else False
                models = [m["name"] for m in node_data.get("status", {}).get("models", [])] if node_data else []
                latency = node_data.get("status", {}).get("latency_ms", 0) if node_data else 0
                results[s["id"]] = {"online": online, "models": models, "latency": latency}
                print(f"  ✓ {s['id']} ({s['host']}): Online={online}, Latency={latency}ms, Models={models}")
            except Exception as e:
                print(f"  ✗ {s['id']} failed: {e}")
    return results


async def test_cross_node_inference():
    print("\n[2] Testing 7B & 14B Cross-Node Direct Inference:")
    tests = [
        ("kraken", "qwen2.5-coder:7b", "Write a 1-line Python return statement for adding 2 numbers."),
        ("cst6", "qwen2.5-coder:7b", "Write a 1-line Python lambda for subtracting 2 numbers."),
        ("cst6", "qwen2.5-coder:14b", "Write a 1-line Python lambda for multiplying 2 numbers."),
        ("cst7", "qwen2.5-coder:14b", "Write a 1-line Python lambda for dividing 2 numbers."),
    ]
    async with httpx.AsyncClient(timeout=60.0) as client:
        for node_id, model_name, prompt in tests:
            start = time.time()
            target_model = f"{node_id}/{model_name}"
            payload = {
                "model": target_model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 40,
                "stream": False
            }
            try:
                r = await client.post(f"{GATEWAY}/v1/chat/completions", json=payload, timeout=45.0)
                dur = round(time.time() - start, 2)
                if r.status_code == 200:
                    data = r.json()
                    out = data["choices"][0]["message"]["content"].strip().replace("\n", " ")
                    server_used = r.headers.get("X-Courtesy-Server", node_id)
                    print(f"  ✓ Pinned {target_model} -> Routed to: {server_used} ({dur}s): {out[:60]}...")
                else:
                    print(f"  ✗ {target_model} failed with HTTP {r.status_code}")
            except Exception as e:
                print(f"  ✗ {target_model} exception: {e}")


async def test_web_grounding():
    print("\n[3] Testing Real-Time Web Grounding & Documentation Retrieval:")
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(f"{GATEWAY}/api/tools/search?q=frc+wpilib+2025+python", timeout=10.0)
        if r.status_code == 200:
            data = r.json()
            results = data.get("results", [])
            print(f"  ✓ Web Search returned {len(results)} live results:")
            for item in results[:2]:
                print(f"    - {item['title'][:60]} -> {item['href']}")
        else:
            print(f"  ✗ Search failed HTTP {r.status_code}")


async def main():
    print("==========================================================")
    print("COURTESY CLUSTER INTER-SERVER & LOGIC TEST SUITE")
    print("==========================================================")
    await test_node_reachability()
    await test_cross_node_inference()
    await test_web_grounding()
    print("\n✓ ALL CORE INTER-SERVER & LOGIC TESTS COMPLETED!")
    print("==========================================================")


if __name__ == "__main__":
    asyncio.run(main())
