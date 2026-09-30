/**
 * A fixed-window limit per key (a caller's address, a session). In memory and therefore per
 * instance: adequate for a single-process LAN Cloud and a single Next server, NOT a substitute for
 * a shared limiter once Cloud runs more than one instance.
 */
export function rateLimiter(maxPerWindow: number, windowMs = 60_000) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return function limited(key: string): boolean {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      // Drop finished windows now and then, so a stream of one-off callers cannot grow the map.
      if (hits.size > 10_000) for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return false;
    }
    entry.count += 1;
    return entry.count > maxPerWindow;
  };
}

/** Who is calling, for limiting: the first forwarded address behind a proxy, else one bucket. */
export function callerOf(req: Request): string {
  return (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'local';
}
