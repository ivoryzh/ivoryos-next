import { NextResponse } from 'next/server';
import { getDevices } from '@/lib/orchestrator';

export async function GET() {
  const devices = getDevices();
  return NextResponse.json(devices);
}
