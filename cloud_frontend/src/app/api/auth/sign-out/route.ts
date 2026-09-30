import { NextResponse } from 'next/server';
import { endSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** POST: end this browser's session. The IvoryOS account and its other sessions are untouched. */
export async function POST() {
  await endSession();
  return NextResponse.json({ ok: true });
}
