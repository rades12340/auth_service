// Fixed-window counter per key (client IP). In memory, so it resets on restart
// and is per-instance; move it to Redis if the service is ever scaled out.
export function createRateLimiter({
    limit,
    windowMs,
}: {
    limit: number;
    windowMs: number;
}) {
    const hits = new Map<string, { count: number; resetAt: number }>();

    return function allow(key: string): boolean {
        const now = Date.now();
        const entry = hits.get(key);
        if (!entry || entry.resetAt <= now) {
            hits.set(key, { count: 1, resetAt: now + windowMs });
            return true;
        }
        entry.count++;
        return entry.count <= limit;
    };
}
