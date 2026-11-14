import { log } from 'apify';
import type { ExtendedApifyClient } from 'apify-orchestrator';

import type { CostTracker } from '../costs.js';
import type { Post } from '../types.js';

export const LINKEDIN_ACTOR = 'harvestapi/linkedin-post-search';
export const YOUTUBE_ACTOR = 'streamers/youtube-scraper';

interface LinkedInItem {
    type?: string;
    id?: string;
    linkedinUrl?: string;
    content?: string;
    author?: { name?: string; linkedinUrl?: string };
    postedAt?: { date?: string; timestamp?: number };
    engagement?: { likes?: number; comments?: number; shares?: number };
}

interface YouTubeItem {
    type?: string;
    id?: string;
    url?: string;
    title?: string;
    text?: string;
    date?: string;
    viewCount?: number;
    likes?: number;
    commentsCount?: number;
    channelName?: string;
    channelUrl?: string;
}

export interface BatchResult {
    posts: Post[];
    capped: boolean;
    runId?: string;
    datasetUrl?: string;
}

/** Child-Run bookkeeping: usageTotalUsd lands a few seconds after SUCCEEDED, so poll until stable. */
async function settledCost(client: ExtendedApifyClient, runId: string): Promise<number> {
    let last = -1;
    for (const waitMs of [0, 1500, 2500, 3000, 3000]) {
        if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
        const cost = (await client.run(runId).get())?.usageTotalUsd ?? 0;
        if (cost > 0 && cost === last) return cost;
        last = cost;
    }
    return Math.max(last, 0);
}

async function runChild<T>(
    client: ExtendedApifyClient,
    costs: CostTracker,
    step: 'linkedin' | 'youtube',
    actor: string,
    input: Record<string, unknown>,
): Promise<{ items: T[]; runId: string; datasetId: string } | null> {
    const cap = costs.remaining(step);
    if (cap <= 0) {
        log.warning(`Skipping ${step}: no budget left`);
        return null;
    }
    const run = await client.actor(actor).call(input, {
        runName: `${step}-${Date.now()}`,
        ...(Number.isFinite(cap) ? { maxTotalChargeUsd: Number(cap.toFixed(4)) } : {}),
    });
    const provisional = await settledCost(client, run.id);
    costs.add(step, provisional);
    costs.trackRun(step, run.id, provisional);
    if (run.status !== 'SUCCEEDED') {
        log.warning(`${actor} ended as ${run.status} (https://console.apify.com/actors/runs/${run.id}); using what it saved`);
    }
    const items: T[] = [];
    // The run has finished, so page through its dataset in chunks (avoids the V8 string limit).
    for (let offset = 0; ; offset += 200) {
        const page = await client.dataset(run.defaultDatasetId).listItems({ offset, limit: 200, clean: true });
        items.push(...(page.items as T[]));
        if (page.items.length < 200) break;
    }
    return { items, runId: run.id, datasetId: run.defaultDatasetId };
}

export async function collectLinkedIn(
    client: ExtendedApifyClient,
    costs: CostTracker,
    queries: string[],
    opts: { sinceDate?: string; postedLimit?: string; maxPerQuery: number; sortBy?: 'date' | 'relevance' },
): Promise<BatchResult> {
    const input: Record<string, unknown> = {
        searchQueries: queries,
        maxPosts: opts.maxPerQuery,
        // "date" returns newest first, so a multi-day window only reaches back a few hours on busy
        // days. "relevance" spreads the sample across the whole window (used for backfills).
        sortBy: opts.sortBy ?? 'date',
        profileScraperMode: 'short',
    };
    if (opts.sinceDate) input.postedLimitDate = opts.sinceDate;
    if (opts.postedLimit) input.postedLimit = opts.postedLimit;

    const res = await runChild<LinkedInItem>(client, costs, 'linkedin', LINKEDIN_ACTOR, input);
    if (!res) return { posts: [], capped: true };
    const posts: Post[] = [];
    for (const i of res.items) {
        if (i.type && i.type !== 'post') continue;
        if (!i.id || !i.content || !i.linkedinUrl) continue;
        const date = i.postedAt?.date ?? (i.postedAt?.timestamp ? new Date(i.postedAt.timestamp).toISOString() : undefined);
        if (!date) continue;
        posts.push({
            platform: 'linkedin',
            id: `li_${i.id}`,
            url: i.linkedinUrl,
            author: i.author?.name ?? 'LinkedIn member',
            authorUrl: i.author?.linkedinUrl,
            text: i.content.trim(),
            publishedAt: new Date(date).toISOString(),
            engagement: (i.engagement?.likes ?? 0) + (i.engagement?.comments ?? 0) + (i.engagement?.shares ?? 0),
            source: LINKEDIN_ACTOR,
        });
    }
    log.info(`LinkedIn: ${posts.length} posts`);
    return {
        posts,
        capped: res.items.length >= queries.length * opts.maxPerQuery,
        runId: res.runId,
        datasetUrl: `https://console.apify.com/storage/datasets/${res.datasetId}`,
    };
}

export async function collectYouTube(
    client: ExtendedApifyClient,
    costs: CostTracker,
    queries: string[],
    opts: { sinceDate?: string; dateFilter?: 'hour' | 'today'; maxPerQuery: number },
): Promise<BatchResult> {
    const input: Record<string, unknown> = {
        searchQueries: queries,
        maxResults: opts.maxPerQuery,
        maxResultsShorts: 0,
        maxResultStreams: 0,
        sortingOrder: 'date',
    };
    if (opts.sinceDate) input.oldestPostDate = opts.sinceDate;
    if (opts.dateFilter) input.dateFilter = opts.dateFilter;

    const res = await runChild<YouTubeItem>(client, costs, 'youtube', YOUTUBE_ACTOR, input);
    if (!res) return { posts: [], capped: true };
    const posts: Post[] = [];
    for (const i of res.items) {
        if (!i.id || !i.url || !i.title || !i.date) continue;
        posts.push({
            platform: 'youtube',
            id: `yt_${i.id}`,
            url: i.url,
            author: i.channelName ?? 'YouTube channel',
            authorUrl: i.channelUrl,
            // Title carries the take; the first lines of the description add context for scoring.
            text: `${i.title}\n${(i.text ?? '').split('\n').slice(0, 4).join(' ')}`.slice(0, 600).trim(),
            publishedAt: new Date(i.date).toISOString(),
            engagement: (i.likes ?? 0) + (i.commentsCount ?? 0) + Math.round((i.viewCount ?? 0) / 100),
            source: YOUTUBE_ACTOR,
        });
    }
    log.info(`YouTube: ${posts.length} videos`);
    return {
        posts,
        capped: res.items.length >= queries.length * opts.maxPerQuery,
        runId: res.runId,
        datasetUrl: `https://console.apify.com/storage/datasets/${res.datasetId}`,
    };
}
