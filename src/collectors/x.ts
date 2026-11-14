import { log } from 'apify';
import type { ExtendedApifyClient } from 'apify-orchestrator';

import type { CostTracker } from '../costs.js';
import type { Post } from '../types.js';
import { runChild } from './social.js';

/**
 * xquik/x-tweet-scraper: a batch-run (input interface) X search at $0.00015 per tweet that works on
 * every Apify plan. apidojo/x-api (server interface) refuses accounts without a paid plan.
 */
export const X_ACTOR = 'xquik/x-tweet-scraper';

const FIELDS = ['id', 'url', 'text', 'createdAt', 'likeCount', 'retweetCount', 'replyCount', 'quoteCount', 'authorUsername', 'searchTerm'];

interface XItem {
    id?: string;
    url?: string;
    text?: string;
    createdAt?: string;
    likeCount?: number;
    retweetCount?: number;
    replyCount?: number;
    quoteCount?: number;
    authorUsername?: string;
    searchTerm?: string;
}

function toPost(t: XItem): Post | null {
    if (!t.id || !t.url || !t.text || !t.createdAt) return null; // diagnostic rows have no tweet
    const published = new Date(t.createdAt);
    if (Number.isNaN(published.getTime())) return null;
    return {
        platform: 'x',
        id: `x_${t.id}`,
        url: t.url,
        author: t.authorUsername ? `@${t.authorUsername}` : 'unknown',
        authorUrl: t.authorUsername ? `https://x.com/${t.authorUsername}` : undefined,
        text: t.text.trim(),
        publishedAt: published.toISOString(),
        engagement: (t.likeCount ?? 0) + (t.retweetCount ?? 0) + (t.replyCount ?? 0) + (t.quoteCount ?? 0),
        source: X_ACTOR,
    };
}

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

/**
 * Whole UTC days, each split into time slices so the sample covers the full day instead of only
 * its last hours (X search returns newest first). One child run covers every day in the range.
 */
export async function collectXDays(
    client: ExtendedApifyClient,
    costs: CostTracker,
    baseQuery: string,
    days: string[],
    opts: { perDay: number; slicesPerDay?: number },
) {
    const slices = opts.slicesPerDay ?? 4;
    const perSlice = Math.max(10, Math.ceil(opts.perDay / slices));
    const termDay = new Map<string, string>();
    for (const day of days) {
        const start = new Date(`${day}T00:00:00Z`).getTime();
        for (let s = 0; s < slices; s++) {
            const from = new Date(start + (s * 86_400_000) / slices);
            const to = new Date(start + ((s + 1) * 86_400_000) / slices);
            termDay.set(`${baseQuery} since_time:${unix(from)} until_time:${unix(to)}`, day);
        }
    }
    const terms = [...termDay.keys()];
    const res = await runChild<XItem>(client, costs, 'x', X_ACTOR, {
        searchTerms: terms,
        queryType: 'Latest',
        maxItemsPerTarget: perSlice,
        maxItems: terms.length * perSlice,
        includeSearchTerms: true,
        fields: FIELDS,
    });
    if (!res) return { posts: [] as Post[], cappedByDay: Object.fromEntries(days.map((d) => [d, true])) };

    const perTerm = new Map<string, number>();
    const posts: Post[] = [];
    for (const item of res.items) {
        const post = toPost(item);
        if (!post) continue;
        posts.push(post);
        if (item.searchTerm) perTerm.set(item.searchTerm, (perTerm.get(item.searchTerm) ?? 0) + 1);
    }
    // A day is a floor (not a full count) when any of its slices hit the per-slice cap.
    const cappedByDay: Record<string, boolean> = {};
    for (const [term, day] of termDay) cappedByDay[day] ||= (perTerm.get(term) ?? 0) >= perSlice;
    log.info(`X: ${posts.length} tweets over ${days.length} day(s) (${perSlice} max per ${24 / slices}h slice)`);
    return { posts, cappedByDay, datasetUrl: `https://console.apify.com/storage/datasets/${res.datasetId}` };
}

/** Live window: every tweet from the last `minutes`, up to `max`. */
export async function collectXLive(client: ExtendedApifyClient, costs: CostTracker, baseQuery: string, minutes: number, max: number) {
    const since = new Date(Date.now() - minutes * 60_000);
    const res = await runChild<XItem>(client, costs, 'x', X_ACTOR, {
        searchTerms: [`${baseQuery} since_time:${unix(since)}`],
        queryType: 'Latest',
        maxItems: max,
        fields: FIELDS,
    });
    if (!res) return { posts: [] as Post[], capped: true };
    const posts = res.items.map(toPost).filter((p): p is Post => !!p && new Date(p.publishedAt) >= since);
    log.info(`X live: ${posts.length} tweets in the last ${minutes} min`);
    return { posts, capped: posts.length >= max };
}
