import { Actor, log } from 'apify';
import { Orchestrator, type ExtendedApifyClient } from 'apify-orchestrator';

import { aggregate, byPlatform, emptyAgg, forDisplay, groupByDay, mergeAgg, pickForScoring, utcDay } from './aggregate.js';
import { collectQuotes, collectTickerSentiment, NASDAQ_ACTOR, SENTIMENT_ACTOR, YAHOO_ACTOR } from './collectors/markets.js';
import { collectNews, MARKETWATCH_ACTOR } from './collectors/news.js';
import { collectLinkedIn, collectReddit, collectThreads, collectYouTube, LINKEDIN_ACTOR, REDDIT_ACTOR, THREADS_ACTOR, YOUTUBE_ACTOR } from './collectors/social.js';
import { collectXDays, collectXLive, X_ACTOR } from './collectors/x.js';
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
    maxXTweetsPerDay?: number;
    maxXTweetsLive?: number;
    maxLinkedInPostsPerQuery?: number;
    maxYouTubeVideosPerQuery?: number;
    maxThreadsPostsPerQuery?: number;
    maxThreadsPostsLive?: number;
    maxRedditPostsPerQuery?: number;
    maxRedditPostsLive?: number;
    maxScoredPerPlatformDay?: number;
    liveWindowMinutes?: number;
    storeName?: string;
}

// Every step that spends money. The run's maxTotalChargeUsd is split evenly across them.
const STEPS = ['x', 'linkedin', 'youtube', 'threads', 'reddit', 'news', 'markets', 'llm'] as const;

await Actor.init();

const input = (await Actor.getInput<Input>()) ?? {};
const mode: Mode = input.mode ?? 'daily';
// Requiring "Anthropic" keeps X from loosely matching $ANT to any "ant" (measured: ~60% noise otherwise).
const xQuery = input.xQuery ?? 'Anthropic (IPO OR stock OR shares OR valuation OR $ANT) -filter:retweets';
const searchQueries = input.searchQueries ?? ['Anthropic IPO', 'Anthropic stock', 'Anthropic valuation'];
const liveTicker = (input.liveTicker ?? 'ANT').toUpperCase();
const peers = (input.peerTickers ?? ['AMZN', 'GOOGL', 'NVDA', 'MSFT', 'QQQ']).map((s) => s.toUpperCase());
const llmModel = input.llmModel ?? 'google/gemini-2.5-flash';
const maxXPerDay = input.maxXTweetsPerDay ?? 1000;
const maxXLive = input.maxXTweetsLive ?? 500;
const maxLinkedIn = input.maxLinkedInPostsPerQuery ?? 50;
const maxYouTube = input.maxYouTubeVideosPerQuery ?? 25;
const maxThreads = input.maxThreadsPostsPerQuery ?? 30;
const maxThreadsLive = input.maxThreadsPostsLive ?? 20;
const maxReddit = input.maxRedditPostsPerQuery ?? 50;
const maxRedditLive = input.maxRedditPostsLive ?? 30;
// LLM sample per platform per UTC day; volume still counts every collected post.
const scoreCap = input.maxScoredPerPlatformDay ?? 300;
const SOCIAL = ['x', 'linkedin', 'youtube', 'threads', 'reddit'] as const;
// Matches the D-day schedule (every 15 min), so consecutive snapshots don't overlap.
const liveWindow = input.liveWindowMinutes ?? 15;
const storeName = input.storeName ?? 'anthropic-ipo';

const today = utcDay(new Date().toISOString());
const yesterday = utcDay(new Date(Date.now() - 86_400_000).toISOString());
const dateFrom = input.dateFrom ?? (mode === 'backfill' || mode === 'rescore' ? '2026-11-05' : yesterday);
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
                const r = await collectXDays(client, costs, xQuery, days, { perDay: maxXPerDay });
                Object.assign(capByDay, r.cappedByDay);
                if (r.datasetUrl) subDatasets.push({ name: X_ACTOR, resultUrl: r.datasetUrl });
                return r.posts;
            },
            [],
        ),
    );
    tasks.push(
        safe(
            'LinkedIn',
            async () => {
                const r = await collectLinkedIn(client, costs, searchQueries, {
                    sinceDate: dateFrom,
                    maxPerQuery: maxLinkedIn * days.length,
                    sortBy: days.length > 1 ? 'relevance' : 'date',
                });
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
    tasks.push(
        safe(
            'Threads',
            async () => {
                const until = utcDay(new Date(new Date(`${dateTo}T00:00:00Z`).getTime() + 86_400_000).toISOString());
                const r = await collectThreads(client, costs, searchQueries, {
                    since: dateFrom,
                    until,
                    maxPerQuery: maxThreads * Math.min(days.length, 4),
                });
                capped.threads = r.capped;
                if (r.datasetUrl) subDatasets.push({ name: THREADS_ACTOR, resultUrl: r.datasetUrl });
                return r.posts;
            },
            [],
        ),
    );
    tasks.push(
        safe(
            'Reddit',
            async () => {
                const r = await collectReddit(client, costs, searchQueries, {
                    postedAfter: dateFrom,
                    maxPerQuery: maxReddit * Math.min(days.length, 4),
                });
                capped.reddit = r.capped;
                if (r.datasetUrl) subDatasets.push({ name: REDDIT_ACTOR, resultUrl: r.datasetUrl });
                return r.posts;
            },
            [],
        ),
    );
}

// D-day snapshot: the two fast-moving platforms only (LinkedIn and YouTube stay daily).
if (mode === 'live') {
    tasks.push(
        safe(
            'X live',
            async () => {
                const r = await collectXLive(client, costs, xQuery, liveWindow, maxXLive);
                capped.x = r.capped;
                return r.posts;
            },
            [],
        ),
    );
    tasks.push(
        safe(
            'Threads live',
            async () => {
                // Threads only filters by whole dates, so fetch today and keep the window below.
                const r = await collectThreads(client, costs, searchQueries, {
                    since: today,
                    until: utcDay(new Date(Date.now() + 86_400_000).toISOString()),
                    maxPerQuery: maxThreadsLive,
                });
                capped.threads = r.capped;
                return r.posts;
            },
            [],
        ),
    );
    tasks.push(
        safe(
            'Reddit live',
            async () => {
                const r = await collectReddit(client, costs, searchQueries, {
                    postedAfter: today,
                    maxPerQuery: maxRedditLive,
                });
                capped.reddit = r.capped;
                return r.posts;
            },
            [],
        ),
    );
}

const postsDataset = await Actor.openDataset(`${storeName}-posts`, { forceCloud: true });

// rescore: no scraping. Re-read the posts already saved for the range and score the unscored ones.
if (mode === 'rescore') {
    tasks.push(
        safe(
            'Load saved posts',
            async () => {
                const best = new Map<string, ScoredPost>();
                for (let offset = 0; ; offset += 1000) {
                    const page = await postsDataset.getData({ offset, limit: 1000 });
                    for (const row of page.items as unknown as ScoredPost[]) {
                        if (!(SOCIAL as readonly string[]).includes(row.platform)) continue;
                        const d = utcDay(row.publishedAt);
                        if (d < dateFrom || d > dateTo) continue;
                        const prev = best.get(row.id);
                        if (!prev || (prev.stance == null && row.stance != null)) best.set(row.id, row);
                    }
                    if (page.items.length < 1000) break;
                }
                log.info(`Loaded ${best.size} saved posts for ${dateFrom} → ${dateTo}`);
                return [...best.values()];
            },
            [],
        ),
    );
}

// News runs in every collecting mode: the feeds are rolling windows, so each sweep adds what is new.
const seenNews = await store.seenNews();
if (mode !== 'rescore') {
    tasks.push(safe('News', () => collectNews(peers.filter((p) => p !== 'QQQ'), costs), []));
}

const marketsTask =
    mode === 'rescore'
        ? Promise.resolve([[], []] as [Awaited<ReturnType<typeof collectQuotes>>, Awaited<ReturnType<typeof collectTickerSentiment>>])
        : Promise.all([
              safe('Quotes', () => collectQuotes([liveTicker, ...peers], costs), []),
              safe('Ticker sentiment', () => collectTickerSentiment([liveTicker, ...peers.filter((p) => p !== 'QQQ')], costs), []),
          ]);

const collected = (await Promise.all(tasks)).flat();
const [quotes, tickerSentiment] = await marketsTask;

// Dedupe by id; news appears on several peers' pages.
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
// 2. Score a sample with an LLM via the Apify OpenRouter Standby Actor
//    (up to scoreCap posts per platform per day; news is always scored in full)
// ---------------------------------------------------------------------------
const alreadyJudged = (p: Post) => (p as ScoredPost).stance != null;
const candidates = [...inScope.filter((p) => p.platform === 'news'), ...pickForScoring(inScope.filter((p) => p.platform !== 'news'), scoreCap)];
const toScore = candidates.filter((p) => !alreadyJudged(p));
const fresh = await scorePosts(toScore, { model: llmModel, costs });
const freshById = new Map(fresh.map((p) => [p.id, p]));
const unscored = (p: Post): ScoredPost => ({ ...p, relevant: true, score: null, stance: null, extremeness: null });
const scored: ScoredPost[] = inScope.map((p) => freshById.get(p.id) ?? (alreadyJudged(p) ? (p as ScoredPost) : unscored(p)));
log.info(`Scoring sample: ${toScore.length} sent to the LLM, ${inScope.length - candidates.length} counted for volume only`);

const runAt = new Date().toISOString();
// A rescore only appends the posts it newly scored; every other mode saves everything it collected.
const rows = (mode === 'rescore' ? fresh.filter((p) => p.stance != null) : scored).map((p) => ({ ...p, mode, collectedAt: runAt }));
await Actor.pushData(rows);
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

if (mode === 'backfill' || mode === 'daily' || mode === 'rescore') {
    // Social: a re-run for a day replaces that day's numbers (idempotent).
    for (const day of daysBetween(dateFrom, dateTo)) {
        baseline.days[day] ??= {};
        for (const platform of SOCIAL) {
            const posts = (groups.get(platform) ?? []).filter((p) => utcDay(p.publishedAt) === day);
            // A rescore didn't collect anything, so it keeps the cap flags of the run that did.
            const isCapped =
                mode === 'rescore' ? !!baseline.days[day][platform]?.capped : platform === 'x' ? !!capByDay[day] : !!capped[platform];
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
    for (const platform of ['x', 'threads', 'reddit', 'news'] as const) {
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
    liveWindowMinutes: liveWindow,
    actors: {
        server: [YAHOO_ACTOR, NASDAQ_ACTOR, MARKETWATCH_ACTOR, SENTIMENT_ACTOR, OPENROUTER_ACTOR],
        input: [X_ACTOR, LINKEDIN_ACTOR, YOUTUBE_ACTOR, THREADS_ACTOR, REDDIT_ACTOR],
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
