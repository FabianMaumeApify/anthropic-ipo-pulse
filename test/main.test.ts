import { describe, expect, it } from 'vitest';

import { aggregate, forDisplay, mergeAgg, pickForScoring } from '../src/aggregate.js';
import type { ScoredPost } from '../src/types.js';

const post = (over: Partial<ScoredPost>): ScoredPost => ({
    platform: 'x',
    id: Math.random().toString(36),
    url: `https://x.com/a/status/${Math.random()}`,
    author: '@a',
    text: 'Anthropic IPO is going to be the biggest listing of the decade, easy double on day one',
    publishedAt: '2026-11-10T12:00:00.000Z',
    engagement: 10,
    source: 'apidojo/x-api',
    relevant: true,
    score: 0.8,
    stance: 'bull',
    extremeness: 0.9,
    ...over,
});

describe('aggregate', () => {
    it('counts volume, relevance and stances, and ignores irrelevant posts for sentiment', () => {
        const agg = aggregate([
            post({}),
            post({ score: -0.7, stance: 'bear', text: 'This valuation is a bubble and ANT is going to zero within a year, avoid' }),
            post({ relevant: false, score: 0.9 }),
            post({ score: null, stance: null, extremeness: null }),
        ]);
        expect(agg.volume).toBe(4);
        // 2 of the 3 judged posts are relevant, so 4 × 2/3 ≈ 3 posts are estimated relevant
        expect(agg.relevant).toBe(3);
        expect(agg.sampled).toBe(3);
        expect(agg.scored).toBe(2);
        expect(agg.bull).toBe(1);
        expect(agg.bear).toBe(1);
        expect(agg.sentimentSum).toBeCloseTo(0.1);
        expect(agg.topBull).toHaveLength(1);
        expect(agg.topBear).toHaveLength(1);
    });

    it('ranks the most extreme takes first and dedupes near-identical text', () => {
        const agg = aggregate([
            post({ extremeness: 0.2, text: 'Measured take: the Anthropic IPO looks fairly priced given growth and losses' }),
            post({ extremeness: 0.95, text: 'ANT to $500, mortgage the house, Anthropic is the next trillion dollar rocket' }),
            post({ extremeness: 0.95, text: 'ANT to $500, mortgage the house, Anthropic is the next trillion dollar rocket' }),
        ]);
        expect(agg.topBull).toHaveLength(2);
        expect(agg.topBull[0].extremeness).toBe(0.95);
    });

    it('merges news sweeps additively and trims quotes for display', () => {
        const a = aggregate(Array.from({ length: 5 }, (_, i) => post({ text: `Bullish take number ${i} about the Anthropic IPO and its demand` })));
        const b = aggregate(Array.from({ length: 5 }, (_, i) => post({ text: `Another bullish view ${i} on Anthropic stock allocation and pricing` })));
        const m = mergeAgg(a, b);
        expect(m.volume).toBe(10);
        expect(m.bull).toBe(10);
        expect(forDisplay(m).topBull).toHaveLength(3);
    });
});

describe('sampled scoring', () => {
    it('extrapolates relevant volume from the scored sample', () => {
        const judgedRelevant = Array.from({ length: 3 }, (_, i) => post({ text: `Relevant judged take ${i} about the Anthropic IPO pricing` }));
        const judgedIrrelevant = post({ relevant: false, score: 0, stance: 'neutral', extremeness: 0 });
        const unjudged = Array.from({ length: 6 }, () => post({ score: null, stance: null, extremeness: null }));
        const agg = aggregate([...judgedRelevant, judgedIrrelevant, ...unjudged]);
        expect(agg.volume).toBe(10);
        expect(agg.sampled).toBe(4);
        expect(agg.relevant).toBe(8); // 10 × 3/4, rounded
    });

    it('caps each platform-day and always keeps the most-engaged posts', () => {
        const posts = Array.from({ length: 50 }, (_, i) => ({
            id: `p${i}`,
            platform: 'x',
            publishedAt: `2026-11-10T${String(Math.floor(i / 3)).padStart(2, '0')}:00:00.000Z`,
            engagement: i === 7 ? 10_000 : i,
        }));
        const other = { id: 'li1', platform: 'linkedin', publishedAt: '2026-11-10T12:00:00.000Z', engagement: 1 };
        const picked = pickForScoring([...posts, other], 9);
        expect(picked.filter((p) => p.platform === 'x')).toHaveLength(9);
        expect(picked.some((p) => p.id === 'p7')).toBe(true);
        expect(picked.some((p) => p.id === 'li1')).toBe(true);
        expect(new Set(picked.map((p) => p.id)).size).toBe(picked.length);
    });
});
