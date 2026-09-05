import { NextResponse } from 'next/server';

export async function GET() {
  const client = (global as any).mqttClient;
  if (!client) {
    return NextResponse.json({ error: "MQTT Client not initialized yet. Visit the Cloud UI first." });
  }

  const payload = {
    deviceId: "test-device-99",
    schema: { instruments: {}, instrument_meta: {} },
    status: "online"
  };

  client.publish("ivoryos/edge/test-device-99/heartbeat", JSON.stringify(payload));

  return NextResponse.json({ success: true, message: "Published test heartbeat to ivoryos/edge/test-device-99/heartbeat" });
}
