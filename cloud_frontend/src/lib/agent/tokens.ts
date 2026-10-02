import { createHash, randomBytes } from 'node:crypto';

/** A new agent token: `ivc_` + 32 url-safe bytes. Shown once; only its hash is stored. */
export function mintAgentToken(): string {
  return `ivc_${randomBytes(32).toString('base64url')}`;
}

export function hashAgentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
