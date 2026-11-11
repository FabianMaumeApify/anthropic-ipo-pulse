import { log } from 'apify';

import { STANDBY_PRICES, type CostTracker } from '../costs.js';
import { standby } from '../standby.js';
import type { Post } from '../types.js';

export const MARKETWATCH_ACTOR = 'publicmoney/marketwatch-scraper';
export const YAHOO_ACTOR = 'publicmoney/yahoo-finance-scraper';

interface NewsItem {
    status: string;
    headline?: string;
    summary?: string;
    articleBody?: string;
    url?: string;
    guid?: string;
    publisher?: string;
    author?: string;
    datePublished?: string;
}

interface SearchResponse<T> {
    count: number;
    items: T[];
}

const ANTHROPIC_RE = /\banthropic\b|\bclaude\b(?!\s+(?:monet|debussy|van damme))/i;

function toPost(item: NewsItem, source: string): Post | null {
    if (item.status !== 'ok' || !item.url || !item.headline || !item.datePublished) return null;
    const body = [item.summary, item.articleBody].filter(Boolean).join(' ');
    if (!ANTHROPIC_RE.test(`${item.headline} ${body}`)) return null;
    return {
        platform: 'news',
        id: `news_${item.url.replace(/[?#].*$/, '')}`,
        url: item.url,
        author: item.publisher ?? item.author ?? 'news',
        text: `${item.headline}${item.summary ? ` — ${item.summary}` : ''}`.slice(0, 600),
        publishedAt: new Date(item.datePublished).toISOString(),
        engagement: 0,
        source,
    };
}

/**
 * MarketWatch keeps a rolling window (~20 items, about a day), so news is collected by repeated
 * sweeps. Yahoo Finance news for the AI peers adds the Anthropic stories that land on their pages.
 */
export async function collectNews(peers: string[], costs: CostTracker): Promise<Post[]> {
    const posts: Post[] = [];

    try {
        if (costs.canSpend('news', 40 * STANDBY_PRICES.financeRecord)) {
            const mw = await standby<SearchResponse<NewsItem>>(MARKETWATCH_ACTOR, '/search', {
                method: 'POST',
                body: { feeds: ['topstories', 'bulletins'], articlesPerFeed: 100, fullText: false },
                timeoutMs: 240_000,
            });
            costs.add('news', mw.items.filter((i) => i.status === 'ok').length * STANDBY_PRICES.financeRecord);
            const mwPosts = mw.items.map((i) => toPost(i, MARKETWATCH_ACTOR)).filter((p): p is Post => !!p);
            log.info(`MarketWatch: ${mw.items.length} stories, ${mwPosts.length} about Anthropic`);
            posts.push(...mwPosts);
        }
    } catch (err) {
        log.warning(`MarketWatch failed: ${(err as Error).message}`);
    }

    try {
        // yahoo-finance-scraper is a free Actor, so no cost is booked here
        if (peers.length) {
            const yn = await standby<SearchResponse<NewsItem>>(YAHOO_ACTOR, '/search', {
                method: 'POST',
                body: { symbols: peers, mode: 'news', newsPerSymbol: 30, fullText: false },
                timeoutMs: 240_000,
            });
            const ynPosts = yn.items.map((i) => toPost(i, YAHOO_ACTOR)).filter((p): p is Post => !!p);
            log.info(`Yahoo Finance news (${peers.join(',')}): ${yn.items.length} stories, ${ynPosts.length} about Anthropic`);
            posts.push(...ynPosts);
        }
    } catch (err) {
        log.warning(`Yahoo Finance news failed: ${(err as Error).message}`);
    }

    return posts;
}
