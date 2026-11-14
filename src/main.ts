import { Actor, log } from 'apify';
import { Orchestrator, type ExtendedApifyClient } from 'apify-orchestrator';

import { aggregate, byPlatform, emptyAgg, forDisplay, groupByDay, mergeAgg, utcDay } from './aggregate.js';
import { collectQuotes, collectTickerSentiment, NASDAQ_ACTOR, SENTIMENT_ACTOR, YAHOO_ACTOR } from './collectors/markets.js';
import { collectNews, MARKETWATCH_ACTOR } from './collectors/news.js';
import { collectLinkedIn, collectYouTube, LINKEDIN_ACTOR, YOUTUBE_ACTOR } from './collectors/social.js';
import { collectXDay, collectXLive, X_ACTOR } from './collectors/x.js';
import { CostTracker } from './costs.js';
import { OPENROUTER_ACTOR, scorePosts } from './score.js';
import { TrackerStore } from './store.js';
import type { LiveSnapshot, Mode, Platform, Post, ScoredPost } from './types.js';

interface Input {
    mode?: Mode;
    dateFrom?: string;
    dateTo?: string;
    xQuery?: string;
    searchQueries?: string[];
    liveTicker?: string;
    peerTickers?: string[];
    llmModel?: string;
    maxXPagesPerDay?: number;
    maxLinkedInPostsPerQuery?: number;
    maxYouTubeVideosPerQuery?: number;
    liveWindowMinutes?: number;
    storeName?: string;
}

// Every step that spends money. The run's maxTotalChargeUsd is split evenly across them.
const STEPS = ['x', 'linkedin', 'youtube', 'news', 'markets', 'llm'] as const;

await Actor.init();

const input = (await Actor.getInput<Input>()) ?? {};
const mode: Mode = input.mode ?? 'daily';
// Requiring "Anthropic" keeps X from loosely matching $ANT to any "ant" (measured: ~60% noise otherwise).
const xQuery = input.xQuery ?? 'Anthropic (IPO OR stock OR shares OR valuation OR $ANT) -filter:retweets';
const searchQueries = input.searchQueries ?? ['Anthropic IPO', 'Anthropic stock', 'Anthropic valuation'];
const liveTicker = (input.liveTicker ?? 'ANT').toUpperCase();
const peers = (input.peerTickers ?? ['AMZN', 'GOOGL', 'NVDA', 'MSFT', 'QQQ']).map((s) => s.toUpperCase());
const llmModel = input.llmModel ?? 'google/gemini-2.5-flash';
const maxXPagesPerDay = input.maxXPagesPerDay ?? 10;
const maxLinkedIn = input.maxLinkedInPostsPerQuery ?? 50;
const maxYouTube = input.maxYouTubeVideosPerQuery ?? 25;
const liveWindow = input.liveWindowMinutes ?? 60;
const storeName = input.storeName ?? 'anthropic-ipo';

const today = utcDay(new Date().toISOString());
const yesterday = utcDay(new Date(Date.now() - 86_400_000).toISOString());
const dateFrom = input.dateFrom ?? (mode === 'backfill' ? '2026-11-05' : yesterday);
const dateTo = input.dateTo ?? yesterday;

function daysBetween(from: string, to: string): string[] {
    const out: string[] = [];
    for (let d = new Date(`${from}T00:00:00Z`); utcDay(d.toISOString()) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
        out.push(utcDay(d.toISOString()));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Budget: the caller's maxTotalChargeUsd run option, split evenly across STEPS.
// ---------------------------------------------------------------------------
const orchestrator = new Orchestrator({
    enableLogs: true,
    persistenceSupport: 'kvs',
    persistencePrefix: 'ORCH-',
    abortAllRunsOnGracefulAbort: true,
});
const client: ExtendedApifyClient = await orchestrator.apifyClient({ name: 'MAIN' });

let totalBudget = Number.POSITIVE_INFINITY;
const env = Actor.getEnv();
if (env.actorRunId) {
    try {
        const cap = (await client.run(env.actorRunId).get())?.options?.maxTotalChargeUsd;
        if (typeof cap === 'number' && cap > 0) totalBudget = cap;
    } catch {
        // local `apify run` has a synthetic run id
    }
}
const costs = new CostTracker(totalBudget, STEPS);
log.info(
    `Mode ${mode} | ${mode === 'live' ? `last ${liveWindow} min` : `${dateFrom} → ${dateTo}`} | budget ${
        Number.isFinite(totalBudget) ? `$${totalBudget}` : 'uncapped (set maxTotalChargeUsd on the run)'
    }`,
);

const store = await TrackerStore.open(storeName);
const runId = env.actorRunId ?? `local-${Date.now()}`;

Actor.on('aborting', async () => {
    await store.addCosts(runId, mode, costs.byStep);
    await Actor.exit();
});

// ---------------------------------------------------------------------------
// 1. Collect (platforms in parallel; one failing platform does not stop the others)
// ---------------------------------------------------------------------------
const capped: Partial<Record<Platform, boolean>> = {};
const capByDay: Record<string, boolean> = {};
const subDatasets: { name: string; resultUrl: string }[] = [];

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        log.exception(err as Error, `${label} failed`);
        return fallback;
    }
}

const tasks: Promise<Post[]>[] = [];

if (mode === 'backfill' || mode === 'daily') {
    const days = daysBetween(dateFrom, dateTo);
    tasks.push(
        safe(
            'X',
            async () => {
                const all: Post[] = [];
                for (const day of days) {
                    const r = await collectXDay(xQuery, day, maxXPagesPerDay, costs);
                    capByDay[day] = r.capped;
                    all.push(...r.posts);
                }
                return all;
            },
            [],
        ),
    );
    tasks.push(
        safe(
            'LinkedIn',
            async () => {
                const r = await collectLinkedIn(client, costs, searchQueries, { sinceDate: dateFrom, maxPerQuery: maxLinkedIn * days.length });
                capped.linkedin = r.capped;
                if (r.datasetUrl) subDatasets.push({ name: LINKEDIN_ACTOR, resultUrl: r.datasetUrl });
                return r.posts;
            },
            [],
        ),
    );
    tasks.push(
        safe(
            'YouTube',
            async () => {
                const r = await collectYouTube(client, costs, searchQueries, { sinceDate: dateFrom, maxPerQuery: maxYouTube * Math.min(days.length, 4) });
                capped.youtube = r.capped;
                if (r.datasetUrl) subDatasets.push({ name: YOUTUBE_ACTOR, resultUrl: r.datasetUrl });
                return r.posts;
            },
            [],
        ),
    );
}

if (mode === 'live') {
    tasks.push(
        safe(
            'X live',
            async () => {
                const r = await collectXLive(xQuery, liveWindow, Math.max(3, Math.ceil(maxXPagesPerDay / 2)), costs);
                capped.x = r.capped;
                return r.posts;
            },
            [],
        ),
    );
    tasks.push(
        safe(
            'LinkedIn live',
            async () => (await collectLinkedIn(client, costs, searchQueries, { postedLimit: liveWindow <= 60 ? '1h' : '24h', maxPerQuery: 20 })).posts,
            [],
        ),
    );
    tasks.push(
        safe(
            'YouTube live',
            async () => (await collectYouTube(client, costs, searchQueries, { dateFilter: liveWindow <= 60 ? 'hour' : 'today', maxPerQuery: 10 })).posts,
            [],
        ),
    );
}

// News runs in every mode: the feeds are rolling windows, so each sweep adds what is new.
const seenNews = await store.seenNews();
tasks.push(
    safe(
        'News',
        async () => {
            const items = await collectNews(peers.filter((p) => p !== 'QQQ'), costs);
            return items;
        },
        [],
    ),
);

const marketsTask = Promise.all([
    safe('Quotes', () => collectQuotes([liveTicker, ...peers], costs), []),
    safe('Ticker sentiment', () => collectTickerSentiment([liveTicker, ...peers.filter((p) => p !== 'QQQ')], costs), []),
]);

const collected = (await Promise.all(tasks)).flat();
const [quotes, tickerSentiment] = await marketsTask;

// Dedupe by id; X Latest + Top overlap, news appears on several peers' pages.
const unique = [...new Map(collected.map((p) => [p.id, p])).values()];
const windowStart = new Date(Date.now() - liveWindow * 60_000);
const inScope = unique.filter((p) => {
    if (mode === 'live') return p.platform === 'news' ? !seenNews.has(p.id) || new Date(p.publishedAt) >= windowStart : new Date(p.publishedAt) >= windowStart;
    if (p.platform === 'news') return !seenNews.has(p.id);
    const d = utcDay(p.publishedAt);
    return d >= dateFrom && d <= dateTo;
});
log.info(`Collected ${collected.length} items, ${unique.length} unique, ${inScope.length} in scope`);

// ---------------------------------------------------------------------------
// 2. Score with an LLM via the Apify OpenRouter Standby Actor
// ---------------------------------------------------------------------------
const scored: ScoredPost[] = await scorePosts(inScope, { model: llmModel, costs });

const runAt = new Date().toISOString();
const rows = scored.map((p) => ({ ...p, mode, collectedAt: runAt }));
await Actor.pushData(rows);
const postsDataset = await Actor.openDataset(`${storeName}-posts`, { forceCloud: true });
await postsDataset.pushData(rows);

// ---------------------------------------------------------------------------
// 3. Aggregate and store
// ---------------------------------------------------------------------------
const baseline = await store.baseline();
const groups = byPlatform(scored);

// News: incremental. Each story is counted once, on the day it was published.
const newNews = (groups.get('news') ?? []).filter((p) => !seenNews.has(p.id));
for (const [day, posts] of groupByDay(newNews)) {
    baseline.days[day] ??= {};
    baseline.days[day].news = mergeAgg(baseline.days[day].news, aggregate(posts));
}
for (const p of newNews) seenNews.add(p.id);

if (mode === 'backfill' || mode === 'daily') {
    // Social: a re-run for a day replaces that day's numbers (idempotent).
    for (const day of daysBetween(dateFrom, dateTo)) {
        baseline.days[day] ??= {};
        for (const platform of ['x', 'linkedin', 'youtube'] as const) {
            const posts = (groups.get(platform) ?? []).filter((p) => utcDay(p.publishedAt) === day);
            const isCapped = platform === 'x' ? !!capByDay[day] : !!capped[platform];
            baseline.days[day][platform] = aggregate(posts, isCapped);
        }
        baseline.days[day].news ??= emptyAgg();
    }
}

if (quotes.length) baseline.quotes[today] = quotes;
if (tickerSentiment.length) baseline.tickerSentiment[today] = tickerSentiment;
await store.saveBaseline(baseline);
await store.saveSeenNews(seenNews);

if (mode === 'live') {
    const platforms: LiveSnapshot['platforms'] = {};
    for (const platform of ['x', 'linkedin', 'youtube', 'news'] as const) {
        const posts = (groups.get(platform) ?? []).filter((p) => new Date(p.publishedAt) >= windowStart);
        platforms[platform] = forDisplay(aggregate(posts, !!capped[platform]));
    }
    await store.saveLive({ asOf: runAt, windowMinutes: liveWindow, platforms, quotes, tickerSentiment });
}

// Pay-per-event charges keep landing for a few seconds after a child Run succeeds.
if (costs.childRuns.length) {
    await new Promise((r) => setTimeout(r, 8000));
    await costs.reconcile(async (id) => (await client.run(id).get())?.usageTotalUsd ?? 0);
}
const ledger = await store.addCosts(runId, mode, costs.byStep);
await store.setMeta({
    updatedAt: runAt,
    lastRun: { mode, runId, at: runAt, dateFrom, dateTo },
    xQuery,
    searchQueries,
    liveTicker,
    peers,
    llmModel,
    actors: {
        server: [YAHOO_ACTOR, NASDAQ_ACTOR, MARKETWATCH_ACTOR, SENTIMENT_ACTOR, X_ACTOR, OPENROUTER_ACTOR],
        input: [LINKEDIN_ACTOR, YOUTUBE_ACTOR],
    },
});
await Actor.setValue('SUB_DATASETS', subDatasets);

const spent = costs.spent();
log.info(
    `Done. ${scored.length} posts stored, ${scored.filter((p) => p.score != null).length} scored. This run ≈ $${spent.toFixed(4)} (${Object.entries(costs.byStep)
        .map(([k, v]) => `${k} $${v.toFixed(4)}`)
        .join(', ')}). Tracker total ≈ $${ledger.totalUsd.toFixed(2)}.`,
);
await Actor.exit();
