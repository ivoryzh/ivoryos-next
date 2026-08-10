import asyncio
import aiohttp

async def main():
    async with aiohttp.ClientSession() as session:
        payload = {
            "name": "Fast OK Workflow",
            "sequence": [
                {"instrument": "my_pump", "method": "long_running_task", "params": {"duration": 0}}
                for i in range(10)
            ]
        }
        async with session.post("http://localhost:8080/api/queue/runs", json=payload) as resp:
            data = await resp.json()
            run_id = data.get("run_id")
            
        async with session.ws_connect("ws://localhost:8080/api/ws/queue") as ws:
            while True:
                try:
                    msg = await asyncio.wait_for(ws.receive_json(), timeout=5.0)
                    if msg.get("active_run"):
                        status = msg["active_run"]["status"]
                        completed = sum(1 for s in msg["active_run"]["steps"] if s["status"] == "completed")
                        print(f"[Active] Status: {status}, Completed steps: {completed}")
                    elif msg.get("recent_run"):
                        status = msg["recent_run"]["status"]
                        completed = sum(1 for s in msg["recent_run"]["steps"] if s["status"] == "completed")
                        print(f"[Recent] Status: {status}, Completed steps: {completed}")
                        break
                except asyncio.TimeoutError:
                    print("Timeout!")
                    break

asyncio.run(main())
