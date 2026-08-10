from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient
import os

app = FastAPI()
os.makedirs("example/dummy_plugin", exist_ok=True)
app.mount("/plugins/dummy-plugin", StaticFiles(directory="example/dummy_plugin", html=True))

client = TestClient(app)
response = client.get("/plugins/dummy-plugin/index.html")
print("Response status:", response.status_code)
