import { describe, expect, it } from 'vitest';

import { aggregate, forDisplay, mergeAgg, pickForScoring } from '../src/aggregate.js';
import { compactTopics } from '../src/store.js';
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
    topic: 'valuation',
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

describe('topics and extreme takes', () => {
    it('tallies judged relevant posts with a score per topic and counts extreme takes by stance', () => {
        const agg = aggregate([
            post({ topic: 'valuation', score: 0.8, extremeness: 0.9 }),
            post({ topic: 'valuation', score: 0.4, extremeness: 0.7, text: 'Anthropic valuation looks stretched but demand for the IPO is real and broad' }),
            post({ topic: 'bubble', score: -0.6, stance: 'bear', extremeness: 0.95, text: 'AI bubble, ANT is going to zero, this IPO is the top of the cycle for sure' }),
            post({ topic: 'governance', score: 0, stance: 'neutral', extremeness: 0.9 }),
            post({ topic: 'bubble', relevant: false, score: -0.9, stance: 'bear', extremeness: 1 }),
            post({ topic: null, score: null, stance: null, extremeness: null }),
            post({ topic: undefined, score: 0.5, extremeness: 0.2 }), // scored before topics existed
        ]);
        expect(agg.topics?.valuation?.n).toBe(2);
        expect(agg.topics?.valuation?.sentimentSum).toBeCloseTo(1.2);
        expect(agg.topics?.bubble).toEqual({ n: 1, sentimentSum: -0.6 });
        expect(agg.topics?.governance).toEqual({ n: 1, sentimentSum: 0 });
        expect(agg.topics?.other).toBeUndefined();
        expect(agg.extremeBull).toBe(2);
        expect(agg.extremeBear).toBe(1);
    });

    it('sums topics and extreme counts in mergeAgg and passes them through forDisplay', () => {
        const a = aggregate([
            post({ topic: 'access', score: 0.5, extremeness: 0.8 }),
            post({ topic: 'macro', score: -0.2, stance: 'bear', extremeness: 0.75, text: 'Rates are up and the Nasdaq is weak, bad timing for the Anthropic listing' }),
        ]);
        const b = aggregate([post({ topic: 'access', score: 0.3, extremeness: 0.1, text: 'Where can retail buy ANT shares at the IPO price? Robinhood allocation open' })]);
        const m = mergeAgg(a, b);
        expect(m.topics?.access?.n).toBe(2);
        expect(m.topics?.access?.sentimentSum).toBeCloseTo(0.8);
        expect(m.topics?.macro).toEqual({ n: 1, sentimentSum: -0.2 });
        expect(m.extremeBull).toBe(1);
        expect(m.extremeBear).toBe(1);
        expect(forDisplay(m).topics).toEqual(m.topics);
        expect(forDisplay(m).extremeBull).toBe(1);
    });

    it('merges with aggregates stored before topics existed', () => {
        const { topics: _t, extremeBull: _b, extremeBear: _r, ...legacy } = aggregate([post({ topic: 'safety' })]);
        const fresh = aggregate([post({ topic: 'safety', score: 0.2, extremeness: 0.1, text: 'Anthropic says safety stays the mission after the IPO, the trust keeps control' })]);
        const m = mergeAgg(legacy, fresh);
        expect(m.topics).toEqual({ safety: { n: 1, sentimentSum: 0.2 } });
        expect(m.extremeBull).toBe(0);
        expect(mergeAgg(legacy, { ...legacy }).topics).toBeUndefined();
        expect(mergeAgg(legacy, { ...legacy }).extremeBear).toBeUndefined();
    });
});

describe('live timeline', () => {
    it('keeps only topics that occurred and rounds their sentiment sums', () => {
        expect(compactTopics({ valuation: { n: 2, sentimentSum: 0.123456 }, bubble: { n: 0, sentimentSum: 0 } })).toEqual({
            valuation: { n: 2, sentimentSum: 0.123 },
        });
        expect(compactTopics(undefined)).toBeUndefined();
    });
});
