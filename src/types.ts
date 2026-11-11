export type Platform = 'x' | 'linkedin' | 'youtube' | 'news';
export const PLATFORMS: Platform[] = ['x', 'linkedin', 'youtube', 'news'];

export type Mode = 'backfill' | 'daily' | 'news' | 'live';

export interface Post {
    platform: Platform;
    id: string;
    url: string;
    author: string;
    authorUrl?: string;
    text: string;
    publishedAt: string; // ISO 8601
    engagement: number; // likes + comments + shares/retweets (+ views/100 for YouTube)
    source: string; // Apify Actor that produced it
}

export type Stance = 'bull' | 'bear' | 'neutral';

export interface ScoredPost extends Post {
    relevant: boolean;
    score: number | null; // -1 .. 1
    stance: Stance | null;
    extremeness: number | null; // 0 .. 1
}

export interface QuoteCard {
    platform: Platform;
    url: string;
    author: string;
    text: string;
    publishedAt: string;
    engagement: number;
    score: number;
    extremeness: number;
}

/** Mergeable per-day, per-platform aggregate (sums, not averages, so news sweeps can add up). */
export interface Agg {
    volume: number; // posts collected (after dedupe, before relevance filter)
    relevant: number; // posts the scorer judged to be about Anthropic
    engagement: number;
    scored: number;
    sentimentSum: number;
    bull: number;
    bear: number;
    neutral: number;
    capped: boolean; // true when collection hit a page/item limit (volume is a floor)
    topBull: QuoteCard[];
    topBear: QuoteCard[];
    updatedAt: string;
}

export interface TickerQuote {
    symbol: string;
    name?: string;
    price: number | null;
    changePercent: number | null;
    previousClose: number | null;
    volume: number | null;
    marketCap: number | null;
    marketStatus?: string;
    asOf: string;
    source: string;
}

export interface TickerSentiment {
    symbol: string;
    score: number;
    label: string;
    storyCount: number;
    positive: number;
    negative: number;
    neutral: number;
    asOf: string;
}

export interface Baseline {
    updatedAt: string;
    days: Record<string, Partial<Record<Platform, Agg>>>; // key: YYYY-MM-DD (UTC)
    quotes: Record<string, TickerQuote[]>; // daily snapshot of peer/ANT quotes
    tickerSentiment: Record<string, TickerSentiment[]>; // daily sentiment-mini snapshot
}

export interface LiveSnapshot {
    asOf: string;
    windowMinutes: number;
    platforms: Partial<Record<Platform, Agg>>;
    quotes: TickerQuote[];
    tickerSentiment: TickerSentiment[];
}

export interface CostLedger {
    totalUsd: number;
    byStep: Record<string, number>;
    runs: { runId: string; mode: Mode; usd: number; at: string }[];
}
