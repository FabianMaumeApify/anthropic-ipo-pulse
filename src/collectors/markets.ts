import { log } from 'apify';

import { STANDBY_PRICES, type CostTracker } from '../costs.js';
import { standby } from '../standby.js';
import type { TickerQuote, TickerSentiment } from '../types.js';

export const YAHOO_ACTOR = 'publicmoney/yahoo-finance-scraper';
export const NASDAQ_ACTOR = 'publicmoney/nasdaq-scraper';
export const SENTIMENT_ACTOR = 'publicmoney/sentiment-mini';

interface QuoteItem {
    status: string;
    requested: string;
    tickerSymbol?: string;
    name?: string;
    value?: number;
    changePercent?: number;
    previousClose?: number;
    volume?: number;
    marketCap?: number;
    marketStatus?: string;
    scrapedAt?: string;
}

interface SentimentItem {
    status: string;
    requested: string;
    score?: number;
    label?: string;
    storyCount?: number;
    positive?: number;
    negative?: number;
    neutral?: number;
    scrapedAt?: string;
}

interface SearchResponse<T> {
    count: number;
    items: T[];
}

function toQuote(i: QuoteItem, source: string): TickerQuote {
    const prev = i.previousClose ?? null;
    const price = i.value ?? null;
    return {
        symbol: i.tickerSymbol ?? i.requested,
        name: i.name,
        price,
        changePercent: i.changePercent ?? (price != null && prev ? ((price - prev) / prev) * 100 : null),
        previousClose: prev,
        volume: i.volume ?? null,
        marketCap: i.marketCap ?? null,
        marketStatus: i.marketStatus,
        asOf: i.scrapedAt ?? new Date().toISOString(),
        source,
    };
}

/** Yahoo Finance first (free); Nasdaq for any symbol Yahoo could not quote. */
export async function collectQuotes(symbols: string[], costs: CostTracker): Promise<TickerQuote[]> {
    const out = new Map<string, TickerQuote>();
    try {
        const y = await standby<SearchResponse<QuoteItem>>(YAHOO_ACTOR, '/search', {
            method: 'POST',
            body: { symbols, mode: 'quote' },
        });
        for (const i of y.items) if (i.status === 'ok' && i.value != null) out.set(i.requested, toQuote(i, YAHOO_ACTOR));
    } catch (err) {
        log.warning(`Yahoo quotes failed: ${(err as Error).message}`);
    }
    const missing = symbols.filter((s) => !out.has(s));
    if (missing.length && costs.canSpend('markets', missing.length * STANDBY_PRICES.financeRecord)) {
        try {
            const n = await standby<SearchResponse<QuoteItem>>(NASDAQ_ACTOR, '/search', {
                method: 'POST',
                body: { symbols: missing, mode: 'quote', assetClass: 'stocks' },
            });
            for (const i of n.items) {
                if (i.status !== 'ok' || i.value == null) continue;
                costs.add('markets', STANDBY_PRICES.financeRecord);
                out.set(i.requested, toQuote(i, NASDAQ_ACTOR));
            }
        } catch (err) {
            log.warning(`Nasdaq quotes failed: ${(err as Error).message}`);
        }
    }
    const stillMissing = symbols.filter((s) => !out.has(s));
    if (stillMissing.length) log.info(`No quote yet for: ${stillMissing.join(', ')} (expected for ANT before it trades)`);
    return symbols.filter((s) => out.has(s)).map((s) => out.get(s)!);
}

export async function collectTickerSentiment(symbols: string[], costs: CostTracker): Promise<TickerSentiment[]> {
    if (!symbols.length || !costs.canSpend('markets', symbols.length * STANDBY_PRICES.financeRecord)) return [];
    try {
        const r = await standby<SearchResponse<SentimentItem>>(SENTIMENT_ACTOR, '/search', {
            method: 'POST',
            body: { tickers: symbols, newsPerTicker: 15 },
            timeoutMs: 240_000,
        });
        const ok = r.items.filter((i) => i.status === 'ok');
        costs.add('markets', ok.length * STANDBY_PRICES.financeRecord);
        return ok.map((i) => ({
            symbol: i.requested,
            score: i.score ?? 0,
            label: i.label ?? 'neutral',
            storyCount: i.storyCount ?? 0,
            positive: i.positive ?? 0,
            negative: i.negative ?? 0,
            neutral: i.neutral ?? 0,
            asOf: i.scrapedAt ?? new Date().toISOString(),
        }));
    } catch (err) {
        log.warning(`sentiment-mini failed: ${(err as Error).message}`);
        return [];
    }
}
