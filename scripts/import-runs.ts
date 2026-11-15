// Rebuilds the tracker's history in the account you are logged in to (`apify login`)
// from the datasets of public runs on another account. No scraping, no LLM calls.
//
//   .\node_modules\.bin\tsx.cmd scripts\import-runs.ts <runId> [<runId> ...]
//
// - Merges the runs' posts (a scored copy of a post wins over an unscored one) and saves them
//   to the named dataset `anthropic-ipo-posts`, so later `rescore` runs can use them.
// - Re-aggregates them with the Actor's own code into the `baseline` record of the named
//   key-value store `anthropic-ipo`, plus `meta`, `costs` and `news-seen`.
// The token is read from ~/.apify/auth.json and is never printed.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { aggregate, emptyAgg, groupByDay } from '../src/aggregate.js';
import type { Baseline, CostLedger, Platform, ScoredPost } from '../src/types.js';

const API = 'https://api.apify.com/v2';
const STORE = 'anthropic-ipo';
const DATASET = `${STORE}-posts`;
const X_CAP_PER_DAY = 1000; // maxXTweetsPerDay used by the backfill
const runIds = process.argv.slice(2);
if (!runIds.length) throw new Error('Pass at least one run ID.');

const DRY_RUN = process.env.DRY_RUN === '1';
// Apify CLI < 1.11 stores { token }; newer versions store { activeProfile, profiles: { [id]: { token } } }.
function cliToken(): string | undefined {
    const a = JSON.parse(readFileSync(join(homedir(), '.apify', 'auth.json'), 'utf8')) as {
        token?: string;
        activeProfile?: string;
        profiles?: Record<string, { token?: string }>;
    };
    return a.token ?? (a.activeProfile ? a.profiles?.[a.activeProfile]?.token : undefined);
}
const token = DRY_RUN ? 'dry-run' : cliToken();
if (!DRY_RUN && !token) throw new Error('Not logged in: run `apify login` first.');
const auth = { Authorization: `Bearer ${token}` };

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, init);
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path.split('?')[0]}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
}

const me = DRY_RUN ? { username: '(dry run)' } : (await api<{ data: { username: string } }>('/users/me', { headers: auth })).data;
console.log(`Importing into account ${me.username}`);

// 1. Read the public runs' datasets
type Row = ScoredPost & { mode?: string; collectedAt?: string };
const best = new Map<string, Row>();
let read = 0;
const runCosts: CostLedger['runs'] = [];
for (const runId of runIds) {
    const run = (await api<{ data: { defaultDatasetId: string; startedAt: string; finishedAt: string } }>(`/actor-runs/${runId}`)).data;
    const input = await api<{ mode?: CostLedger['runs'][number]['mode'] }>(`/actor-runs/${runId}/key-value-store/records/INPUT`).catch(() => null);
    runCosts.push({ runId, mode: input?.mode ?? 'backfill', usd: 0, at: run.finishedAt });
    for (let offset = 0; ; offset += 1000) {
        const items = await api<Row[]>(`/datasets/${run.defaultDatasetId}/items?clean=1&offset=${offset}&limit=1000`);
        for (const row of items) {
            const prev = best.get(row.id);
            if (!prev || (prev.stance == null && row.stance != null)) best.set(row.id, row);
        }
        read += items.length;
        if (items.length < 1000) break;
    }
    console.log(`  run ${runId}: dataset ${run.defaultDatasetId} read`);
}
const posts = [...best.values()];
console.log(`${read} rows read, ${posts.length} unique posts`);

// 2. Rebuild the baseline with the Actor's aggregation code
const SOCIAL: Platform[] = ['x', 'linkedin', 'youtube', 'threads'];
const baseline: Baseline = { updatedAt: new Date().toISOString(), days: {}, quotes: {}, tickerSentiment: {} };
const byDay = groupByDay(posts);
for (const day of [...byDay.keys()].sort()) {
    const dayPosts = byDay.get(day)!;
    baseline.days[day] = {};
    for (const platform of SOCIAL) {
        const p = dayPosts.filter((x) => x.platform === platform);
        // The backfill capped X per day; a day that reached ~the cap is a floor, as in the original run.
        baseline.days[day][platform] = aggregate(p, platform === 'x' && p.length >= X_CAP_PER_DAY * 0.9);
    }
    const news = dayPosts.filter((x) => x.platform === 'news');
    baseline.days[day].news = news.length ? aggregate(news) : emptyAgg();
}
for (const [day, d] of Object.entries(baseline.days)) {
    console.log(`  ${day}  ${SOCIAL.concat('news').map((p) => `${p} ${d[p]?.volume ?? 0}`).join('  ')}`);
}

// 3. Write to the logged-in account
if (DRY_RUN) {
    console.log('Dry run: nothing written.');
    process.exit(0);
}
const store = (await api<{ data: { id: string } }>(`/key-value-stores?name=${STORE}`, { method: 'POST', headers: auth })).data;
const put = (key: string, value: unknown) =>
    api(`/key-value-stores/${store.id}/records/${key}`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(value),
    });

const existing = await api<Baseline>(`/key-value-stores/${store.id}/records/baseline`, { headers: auth }).catch(() => null);
if (existing?.days) {
    // Keep any day the new account has already collected itself (for example a daily run since the move).
    for (const [day, d] of Object.entries(existing.days)) if (!baseline.days[day]) baseline.days[day] = d;
    Object.assign(baseline.quotes, existing.quotes);
    Object.assign(baseline.tickerSentiment, existing.tickerSentiment);
}
await put('baseline', baseline);
await put('news-seen', posts.filter((p) => p.platform === 'news').map((p) => p.id));

const prevCosts = await api<CostLedger>(`/key-value-stores/${store.id}/records/costs`, { headers: auth }).catch(() => null);
if (!prevCosts) {
    // Spend of the original account's runs, so the "Apify cost" tile keeps counting from there.
    await put('costs', {
        totalUsd: 9.919013889504539,
        byStep: { x: 1.3943, news: 0.09, markets: 0.0225, linkedin: 4.5282, youtube: 1.8, llm: 2.0157, threads: 0.0684 },
        runs: runCosts,
    } satisfies CostLedger);
}

const existingMeta = await api<Record<string, unknown>>(`/key-value-stores/${store.id}/records/meta`, { headers: auth }).catch(() => null);
if (!existingMeta) {
    await put('meta', {
        updatedAt: new Date().toISOString(),
        lastRun: { mode: 'import', runId: runIds.join(','), at: new Date().toISOString(), dateFrom: Object.keys(baseline.days).sort()[0], dateTo: Object.keys(baseline.days).sort().at(-1) },
        xQuery: 'Anthropic (IPO OR stock OR shares OR valuation OR $ANT) -filter:retweets',
        searchQueries: ['Anthropic IPO', 'Anthropic stock', 'Anthropic valuation'],
        liveTicker: 'ANT',
        peers: ['AMZN', 'GOOGL', 'NVDA', 'MSFT', 'QQQ'],
        llmModel: 'google/gemini-2.5-flash',
        liveWindowMinutes: 15,
        actors: {
            server: ['publicmoney/yahoo-finance-scraper', 'publicmoney/nasdaq-scraper', 'publicmoney/marketwatch-scraper', 'publicmoney/sentiment-mini', 'apify/openrouter'],
            input: ['xquik/x-tweet-scraper', 'harvestapi/linkedin-post-search', 'streamers/youtube-scraper', 'lergassy/threads-scraper'],
        },
    });
}
console.log(`Store ${me.username}~${STORE}: baseline, news-seen, costs, meta written`);

// 4. Posts dataset for later rescore runs
const ds = (await api<{ data: { id: string; itemCount?: number } }>(`/datasets?name=${DATASET}`, { method: 'POST', headers: auth })).data;
const info = (await api<{ data: { itemCount: number } }>(`/datasets/${ds.id}`, { headers: auth })).data;
if (info.itemCount > 0) {
    console.log(`Dataset ${me.username}~${DATASET} already has ${info.itemCount} posts, left as is`);
} else {
    for (let i = 0; i < posts.length; i += 1000) {
        await api(`/datasets/${ds.id}/items`, {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify(posts.slice(i, i + 1000)),
        });
    }
    console.log(`Dataset ${me.username}~${DATASET}: ${posts.length} posts written`);
}
console.log(`Done. Set APIFY_STORE=${me.username}~${STORE} in Vercel.`);
