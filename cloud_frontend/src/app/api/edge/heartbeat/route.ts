import { NextResponse } from 'next/server';
import { registerDevice, getPendingTasks } from '@/lib/orchestrator';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { deviceId, schema } = body;
    
    if (!deviceId) {
      return NextResponse.json({ error: 'deviceId is required' }, { status: 400 });
    }
    
    // Register the device and update its last seen time
    registerDevice(deviceId, schema);
    
    // Check if there are any tasks waiting for this device
    const pendingTasks = getPendingTasks(deviceId);
    
    return NextResponse.json({ tasks: pendingTasks });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
