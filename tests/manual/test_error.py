import asyncio
import aiohttp

async def main():
    async with aiohttp.ClientSession() as session:
        payload = {
            "name": "Error Workflow",
            "sequence": [
                {"instrument": "my_pump", "method": "test_error_handling", "params": {"should_fail": True}}
            ]
        }
        async with session.post("http://localhost:8080/api/queue/runs", json=payload) as resp:
            data = await resp.json()
            
        async with session.ws_connect("ws://localhost:8080/api/ws/queue") as ws:
            while True:
                try:
                    msg = await asyncio.wait_for(ws.receive_json(), timeout=5.0)
                    if msg.get("active_run"):
                        status = msg["active_run"]["status"]
                        print(f"[Active] Status: {status}")
                        if status == "error":
                            break
                    elif msg.get("recent_run"):
                        status = msg["recent_run"]["status"]
                        print(f"[Recent] Status: {status}")
                        break
                except asyncio.TimeoutError:
                    print("Timeout!")
                    break

asyncio.run(main())
