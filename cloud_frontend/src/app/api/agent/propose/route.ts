import { NextResponse } from 'next/server';
import { authorize } from '@/lib/auth';
import { loadLabContext } from '@/lib/agent/context';
import { fileProposal } from '@/lib/agent/proposals';

export const dynamic = 'force-dynamic';

/**
 * File a graph spec for a person to review: {spec, summary?, source?, questions?, allow_invalid?}.
 * A spec with errors is refused (422, with the errors) unless `allow_invalid`, so a tool loop can
 * fix and resend; nothing here saves a workflow or starts a run.
 */
export async function POST(req: Request) {
  const auth = await authorize();
  if ('response' in auth) return auth.response;
  const data = await req.json().catch(() => null);
  if (!data || typeof data !== 'object') return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  const spec = data.spec;
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.steps)) return NextResponse.json({ error: 'A proposal needs a `spec` with a `steps` array.' }, { status: 400 });
  if (JSON.stringify(spec).length > 512_000) return NextResponse.json({ error: 'Proposed workflow is too large.' }, { status: 413 });
  const ws = auth.session.workspace.id;
  const ctx = await loadLabContext(ws, { kind: 'all' });
  const source = String(data.source || (auth.session.agent ? `token:${auth.session.user.name}` : 'api')).slice(0, 128);
  const filed = await fileProposal({ workspaceId: ws, userId: auth.session.user.id, spec, summary: data.summary, source, questions: data.questions, devices: ctx.devices, sequences: ctx.sequences });
  if (!filed.ok && !data.allow_invalid) {
    await (await import('@/lib/store')).getStore().decideAgentProposal(filed.id, { status: 'rejected', result: 'Refused at filing: did not validate' });
    return NextResponse.json({
      error: filed.validation_summary, issues: filed.issues, filed: false,
      hint: 'Fix these and propose again. If you have tried and cannot resolve them, re-send with allow_invalid: true to put the draft in front of a person anyway, and say in the summary what you could not work out.',
    }, { status: 422 });
  }
  return NextResponse.json({
    ...filed,
    note: `Filed for review. It is not saved and will not run until a person accepts it.${filed.ok ? '' : ' Filed with unresolved errors at your request.'}`,
  });
}
