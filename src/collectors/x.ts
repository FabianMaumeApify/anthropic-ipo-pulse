import { log } from 'apify';

import { STANDBY_PRICES, type CostTracker } from '../costs.js';
import { standby } from '../standby.js';
import type { Post } from '../types.js';

export const X_ACTOR = 'apidojo/x-api';

interface XTweet {
    id: string;
    url: string;
    fullText?: string;
    text?: string;
    createdAt: string;
    likeCount?: number;
    retweetCount?: number;
    replyCount?: number;
    quoteCount?: number;
    isRetweet?: boolean;
    author?: { userName?: string; name?: string; url?: string };
}

interface XSearchResponse {
    status: number;
    data?: { tweets?: XTweet[]; cursor?: string };
}

function toPost(t: XTweet): Post {
    return {
        platform: 'x',
        id: `x_${t.id}`,
        url: t.url,
        author: t.author?.userName ? `@${t.author.userName}` : (t.author?.name ?? 'unknown'),
        authorUrl: t.author?.url,
        text: (t.fullText ?? t.text ?? '').trim(),
        publishedAt: new Date(t.createdAt).toISOString(),
        engagement: (t.likeCount ?? 0) + (t.retweetCount ?? 0) + (t.replyCount ?? 0) + (t.quoteCount ?? 0),
        source: X_ACTOR,
    };
}

export interface XSearchArgs {
    query: string;
    sort: 'Latest' | 'Top';
    maxPages: number;
    /** Stop paging once tweets get older than this (Latest only). */
    stopBefore?: Date;
    costs: CostTracker;
}

/** Pages through X search. Returns posts and whether the page limit cut collection short. */
export async function searchX({ query, sort, maxPages, stopBefore, costs }: XSearchArgs) {
    const posts: Post[] = [];
    let cursor: string | undefined;
    let capped = false;
    for (let page = 0; page < maxPages; page++) {
        if (!costs.canSpend('x', STANDBY_PRICES.xRequest)) {
            capped = true;
            break;
        }
        const res = await standby<XSearchResponse>(X_ACTOR, '/search', { query: { query, sort, cursor } });
        costs.add('x', STANDBY_PRICES.xRequest);
        const tweets = res.data?.tweets ?? [];
        for (const t of tweets) if (!t.isRetweet) posts.push(toPost(t));
        cursor = res.data?.cursor;
        const oldest = tweets.length ? new Date(tweets[tweets.length - 1].createdAt) : undefined;
        if (!tweets.length || !cursor) break;
        if (stopBefore && oldest && oldest < stopBefore) break;
        if (page === maxPages - 1) capped = true;
    }
    log.info(`X "${query}" (${sort}): ${posts.length} tweets${capped ? ' (page cap hit)' : ''}`);
    return { posts, capped };
}

/** One UTC day: Latest pages for volume + one Top page so high-engagement posts are present. */
export async function collectXDay(baseQuery: string, day: string, maxPages: number, costs: CostTracker) {
    const next = new Date(`${day}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const q = `${baseQuery} since:${day} until:${next.toISOString().slice(0, 10)}`;
    const latest = await searchX({ query: q, sort: 'Latest', maxPages, costs });
    const top = await searchX({ query: q, sort: 'Top', maxPages: 1, costs });
    return { posts: [...latest.posts, ...top.posts], capped: latest.capped };
}

/** Live window: Latest tweets from the last `minutes`. */
export async function collectXLive(baseQuery: string, minutes: number, maxPages: number, costs: CostTracker) {
    const since = new Date(Date.now() - minutes * 60_000);
    const q = `${baseQuery} since:${since.toISOString().slice(0, 10)}`;
    const { posts, capped } = await searchX({ query: q, sort: 'Latest', maxPages, stopBefore: since, costs });
    return { posts: posts.filter((p) => new Date(p.publishedAt) >= since), capped };
}
