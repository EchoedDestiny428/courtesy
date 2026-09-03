"""
Swarm Execution Test
Runs a fast 1-iteration swarm workflow to test autonomous multi-agent loop.
"""
import asyncio
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import time

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

from src.swarm import get_swarm_nodes, call_node_inference, generate_grounded_context

async def run_test():
    print("--- [1] Checking Swarm Cluster Nodes ---")
    nodes = get_swarm_nodes()
    leader = nodes["leader"]
    w1 = nodes["worker_1"]
    w2 = nodes["worker_2"]
    print(f"Leader:   {leader['server']['id']} ({leader['model']})")
    print(f"Worker 1: {w1['server']['id']} ({w1['model']})")
    print(f"Worker 2: {w2['server']['id']} ({w2['model']})")

    objective = "Write a Python function to check if a string is a palindrome."

    print("\n--- [2] Calling Leader (7B) to decompose objective ---")
    t0 = time.time()
    plan = await call_node_inference(
        leader["server"],
        leader["model"],
        "You are a Lead Architect. Plan the implementation in 2 bullet points.",
        f"Objective: {objective}",
        max_tokens=200
    )
    print(f"Leader responded in {round(time.time() - t0, 2)}s:\n{plan.strip()}")

    print("\n--- [3] Calling Worker 1 (14B) to implement code ---")
    t1 = time.time()
    code = await call_node_inference(
        w1["server"],
        w1["model"],
        "You are a Lead Engineer. Write the clean Python code.",
        f"Objective: {objective}\nPlan: {plan}",
        max_tokens=300
    )
    print(f"Worker 1 responded in {round(time.time() - t1, 2)}s:\n{code.strip()}")

    print("\n--- [4] Calling Worker 2 (14B) to audit and write pytest ---")
    t2 = time.time()
    tests = await call_node_inference(
        w2["server"],
        w2["model"],
        "You are a QA Engineer. Write 2 unit tests for this code.",
        f"Code:\n{code}",
        max_tokens=300
    )
    print(f"Worker 2 responded in {round(time.time() - t2, 2)}s:\n{tests.strip()}")

    print("\n✓ AUTONOMOUS 3-NODE MULTI-AGENT SWARM TEST SUCCESSFUL!")

if __name__ == "__main__":
    asyncio.run(run_test())
