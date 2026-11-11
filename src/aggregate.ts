import type { Agg, Platform, QuoteCard, ScoredPost } from './types.js';

const QUOTES_PER_SIDE = 3;
/** Candidate pool kept per side so later merges (news sweeps) can still re-rank. */
const POOL_PER_SIDE = 8;

export function emptyAgg(): Agg {
    return {
        volume: 0,
        relevant: 0,
        engagement: 0,
        scored: 0,
        sentimentSum: 0,
        bull: 0,
        bear: 0,
        neutral: 0,
        capped: false,
        topBull: [],
        topBear: [],
        updatedAt: new Date().toISOString(),
    };
}

function toCard(p: ScoredPost): QuoteCard {
    return {
        platform: p.platform,
        url: p.url,
        author: p.author,
        text: p.text.slice(0, 420),
        publishedAt: p.publishedAt,
        engagement: p.engagement,
        score: p.score ?? 0,
        extremeness: p.extremeness ?? 0,
    };
}

/** Rank by how extreme the take is, with engagement as a tiebreaker-ish boost. */
function rank(cards: QuoteCard[]): QuoteCard[] {
    const maxE = Math.max(1, ...cards.map((c) => c.engagement));
    const value = (c: QuoteCard) => 0.7 * c.extremeness + 0.3 * (Math.log10(1 + c.engagement) / Math.log10(1 + maxE));
    const seen = new Set<string>();
    return [...cards]
        .sort((a, b) => value(b) - value(a))
        .filter((c) => {
            const key = c.text.toLowerCase().replace(/\W+/g, ' ').slice(0, 80);
            if (seen.has(key) || seen.has(c.url)) return false;
            seen.add(key);
            seen.add(c.url);
            return true;
        });
}

export function aggregate(posts: ScoredPost[], capped = false): Agg {
    const agg = emptyAgg();
    agg.capped = capped;
    const bulls: QuoteCard[] = [];
    const bears: QuoteCard[] = [];
    for (const p of posts) {
        agg.volume++;
        if (!p.relevant) continue;
        agg.relevant++;
        agg.engagement += p.engagement;
        if (p.score == null) continue;
        agg.scored++;
        agg.sentimentSum += p.score;
        if (p.stance === 'bull') agg.bull++;
        else if (p.stance === 'bear') agg.bear++;
        else agg.neutral++;
        if (p.text.length < 40) continue; // too short to be a useful quote
        if (p.stance === 'bull' && p.score > 0) bulls.push(toCard(p));
        if (p.stance === 'bear' && p.score < 0) bears.push(toCard(p));
    }
    agg.topBull = rank(bulls).slice(0, POOL_PER_SIDE);
    agg.topBear = rank(bears).slice(0, POOL_PER_SIDE);
    return agg;
}

/** Adds two aggregates (used by the news sweep, which sees each story only once). */
export function mergeAgg(a: Agg | undefined, b: Agg): Agg {
    if (!a) return b;
    return {
        volume: a.volume + b.volume,
        relevant: a.relevant + b.relevant,
        engagement: a.engagement + b.engagement,
        scored: a.scored + b.scored,
        sentimentSum: a.sentimentSum + b.sentimentSum,
        bull: a.bull + b.bull,
        bear: a.bear + b.bear,
        neutral: a.neutral + b.neutral,
        capped: a.capped || b.capped,
        topBull: rank([...a.topBull, ...b.topBull]).slice(0, POOL_PER_SIDE),
        topBear: rank([...a.topBear, ...b.topBear]).slice(0, POOL_PER_SIDE),
        updatedAt: new Date().toISOString(),
    };
}

/** Trim quote pools to what the site shows. */
export function forDisplay(agg: Agg): Agg {
    return { ...agg, topBull: agg.topBull.slice(0, QUOTES_PER_SIDE), topBear: agg.topBear.slice(0, QUOTES_PER_SIDE) };
}

export function utcDay(iso: string): string {
    return iso.slice(0, 10);
}

export function groupByDay(posts: ScoredPost[]): Map<string, ScoredPost[]> {
    const m = new Map<string, ScoredPost[]>();
    for (const p of posts) {
        const d = utcDay(p.publishedAt);
        if (!m.has(d)) m.set(d, []);
        m.get(d)!.push(p);
    }
    return m;
}

export function byPlatform(posts: ScoredPost[]): Map<Platform, ScoredPost[]> {
    const m = new Map<Platform, ScoredPost[]>();
    for (const p of posts) {
        if (!m.has(p.platform)) m.set(p.platform, []);
        m.get(p.platform)!.push(p);
    }
    return m;
}
