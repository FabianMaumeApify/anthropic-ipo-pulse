import { log } from 'apify';

/** Standby (server-interface) Actors are reached at https://<user>--<name>.apify.actor */
export function standbyBase(actor: string): string {
    return `https://${actor.replace('/', '--')}.apify.actor`;
}

function token(): string {
    const t = process.env.APIFY_TOKEN;
    if (!t) throw new Error('APIFY_TOKEN is not set');
    return t;
}

export interface StandbyOptions {
    method?: 'GET' | 'POST';
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    timeoutMs?: number;
    retries?: number;
}

export async function standby<T>(actor: string, path: string, opts: StandbyOptions = {}): Promise<T> {
    const { method = 'GET', query, body, timeoutMs = 120_000, retries = 2 } = opts;
    const url = new URL(path, standbyBase(actor));
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, {
                method,
                headers: {
                    Authorization: `Bearer ${token()}`,
                    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok) {
                const text = (await res.text()).slice(0, 300);
                // apidojo/x-api answers 429 "Monthly run limit exceeded per user" on accounts without a
                // paid Apify plan. Retrying cannot help, so fail with a message that says what to do.
                if (res.status === 429 && /monthly run limit/i.test(text)) {
                    throw new Error(`${actor} refused the request: monthly limit for this Apify account (needs a paid plan). ${text}`);
                }
                // 4xx other than 429 will not get better on retry
                if (res.status < 500 && res.status !== 429) throw new Error(`${actor}${path} ${res.status}: ${text}`);
                throw Object.assign(new Error(`${actor}${path} ${res.status}: ${text}`), { retryable: true });
            }
            return (await res.json()) as T;
        } catch (err) {
            lastErr = err;
            const retryable = (err as { retryable?: boolean }).retryable || (err as Error).name === 'TimeoutError';
            if (!retryable || attempt === retries) break;
            const wait = 1500 * (attempt + 1);
            log.warning(`Standby ${actor}${path} failed (${(err as Error).message}); retrying in ${wait} ms`);
            await new Promise((r) => setTimeout(r, wait));
        }
    }
    throw lastErr;
}
