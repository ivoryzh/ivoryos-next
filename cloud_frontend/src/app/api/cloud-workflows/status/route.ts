import { NextResponse } from 'next/server';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TASKS_PATH = path.join(os.tmpdir(), 'ivoryos_tasks.json');

export async function GET() {
  try {
    const tasks = JSON.parse(fs.readFileSync(TASKS_PATH, 'utf-8'));
    return NextResponse.json(tasks);
  } catch (error) {
    return NextResponse.json([]); // Return empty array if file missing or parse error
  }
}
