import asyncio
import aiohttp

async def main():
    async with aiohttp.ClientSession() as session:
        # submit first run
        payload1 = {
            "name": "First Run",
            "sequence": [
                {"instrument": "my_pump", "method": "long_running_task", "params": {"duration": 2}},
                {"instrument": "my_pump", "method": "long_running_task", "params": {"duration": 2}}
            ]
        }
        async with session.post("http://localhost:8080/api/queue/runs", json=payload1) as resp:
            data1 = await resp.json()
            run1_id = data1.get("run_id")
            
        # submit second run
        payload2 = {
            "name": "Second Run",
            "sequence": [
                {"instrument": "my_pump", "method": "long_running_task", "params": {"duration": 2}}
            ]
        }
        async with session.post("http://localhost:8080/api/queue/runs", json=payload2) as resp:
            data2 = await resp.json()

        # wait 1 second then cancel first run
        await asyncio.sleep(1)
        print(f"Cancelling run {run1_id}...")
        await session.post(f"http://localhost:8080/api/queue/runs/{run1_id}/cancel")
        
        # connect to ws and listen
        async with session.ws_connect("ws://localhost:8080/api/ws/queue") as ws:
            while True:
                try:
                    msg = await asyncio.wait_for(ws.receive_json(), timeout=5.0)
                    if msg.get("active_run"):
                        print(f"[WS] Active Run: {msg['active_run']['name']} - {msg['active_run']['status']}")
                    elif msg.get("recent_run"):
                        print(f"[WS] Recent Run: {msg['recent_run']['name']} - {msg['recent_run']['status']}")
                except asyncio.TimeoutError:
                    print("Timeout!")
                    break

asyncio.run(main())
