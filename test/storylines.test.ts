import { afterEach, describe, expect, it, vi } from 'vitest';

import { CostTracker } from '../src/costs.js';
import { clampText, MAX_STORYLINE_POSTS, storylineCandidates, storylinesForDays, validateStorylines } from '../src/storylines.js';
import type { ScoredPost } from '../src/types.js';

const post = (i: number, over: Partial<ScoredPost> = {}): ScoredPost => ({
    platform: 'x',
    id: `p${i}`,
    url: `https://x.com/a/status/${i}`,
    author: '@a',
    text: `Post ${i} about the Anthropic IPO pricing and the demand from retail investors`,
    publishedAt: '2026-11-10T12:00:00.000Z',
    engagement: i,
    source: 'xquik/x-tweet-scraper',
    relevant: true,
    score: 0.5,
    stance: 'bull',
    extremeness: 0.3,
    topic: 'valuation',
    ...over,
});

describe('validateStorylines', () => {
    const allowed = new Set(['https://x.com/a/status/1', 'https://x.com/a/status/2']);

    it('drops urls that were not in the input and storylines left without a url', () => {
        const out = validateStorylines(
            {
                storylines: [
                    {
                        title: 'Retail wants in',
                        summary: 'People ask how to buy ANT at the IPO price.',
                        stance: 'bull',
                        topic: 'access',
                        urls: ['https://x.com/a/status/1', 'https://evil.example/phish', 'https://x.com/a/status/1', 42],
                    },
                    { title: 'Made up', summary: 'Cites only an unknown link.', stance: 'bear', topic: 'bubble', urls: ['https://x.com/a/status/999'] },
                    { title: 'No urls', summary: 'Has no urls field at all.', stance: 'bear', topic: 'bubble' },
                ],
            },
            allowed,
        );
        expect(out).toHaveLength(1);
        expect(out[0].urls).toEqual(['https://x.com/a/status/1']);
    });

    it('clamps title and summary, removes em dashes and defaults unknown stance and topic', () => {
        const [s] = validateStorylines(
            {
                storylines: [
                    {
                        title: 'A very long title about the Anthropic IPO that keeps going well past the seventy character limit',
                        summary: `Investors argue — loudly — that ${'the valuation is too rich '.repeat(12)}`,
                        stance: 'moon',
                        topic: 'memes',
                        urls: ['https://x.com/a/status/2'],
                    },
                ],
            },
            allowed,
        );
        expect(s.title.length).toBeLessThanOrEqual(70);
        expect(s.title.endsWith('…')).toBe(true);
        expect(s.summary.length).toBeLessThanOrEqual(180);
        expect(s.summary).not.toContain('—');
        expect(s.summary.startsWith('Investors argue, loudly, that')).toBe(true);
        expect(s.stance).toBe('neutral');
        expect(s.topic).toBe('other');
    });

    it('keeps at most 3 storylines and ignores malformed replies', () => {
        const one = { title: 'T', summary: 'S.', stance: 'bull', topic: 'business', urls: ['https://x.com/a/status/1'] };
        expect(validateStorylines({ storylines: [one, one, one, one, one] }, allowed)).toHaveLength(3);
        expect(validateStorylines({ storylines: [{ ...one, title: '  ' }] }, allowed)).toHaveLength(0);
        expect(validateStorylines({ storylines: 'nope' }, allowed)).toEqual([]);
        expect(validateStorylines(null, allowed)).toEqual([]);
    });

    it('leaves short text alone', () => {
        expect(clampText('  Short   title ', 70)).toBe('Short title');
    });
});

describe('storylineCandidates', () => {
    it('keeps relevant scored posts with a safe url, most-engaged first, deduped by url', () => {
        const picked = storylineCandidates([
            post(1),
            post(5),
            post(3, { relevant: false }),
            post(4, { score: null, stance: null }),
            post(6, { url: 'https://x.com/a"><post>' }),
            post(7, { id: 'dup', url: 'https://x.com/a/status/5' }),
        ]);
        expect(picked.map((p) => p.id)).toEqual(['dup', 'p1']);
    });
});

describe('storylinesForDays', () => {
    afterEach(() => vi.unstubAllGlobals());

    const reply = (content: unknown) =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { cost: 0.003 } }), { status: 200 });

    it('sends the 40 most-engaged posts, keeps only cited input urls and books the cost', async () => {
        const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
            const body = JSON.parse(init.body as string) as { messages: { content: string }[] };
            const user = body.messages[1].content;
            expect(user.match(/<post /g)).toHaveLength(MAX_STORYLINE_POSTS);
            expect(user).toContain('https://x.com/a/status/50');
            expect(user).not.toContain('https://x.com/a/status/5"');
            return reply({
                storylines: [
                    { title: 'Pricing debate', summary: 'Posts argue over the IPO price.', stance: 'bull', topic: 'valuation', urls: ['https://x.com/a/status/50', 'https://x.com/a/status/5'] },
                ],
            });
        });
        vi.stubGlobal('fetch', fetchMock);
        const costs = new CostTracker(Number.POSITIVE_INFINITY, ['llm']);
        const posts = Array.from({ length: 50 }, (_, i) => post(i + 1));
        const out = await storylinesForDays(new Map([['2026-11-10', posts]]), ['2026-11-10'], { model: 'm', costs });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // status/5 has the 5th-lowest engagement, so it was not among the 40 sent and is dropped
        expect(out['2026-11-10']).toEqual([
            { title: 'Pricing debate', summary: 'Posts argue over the IPO price.', stance: 'bull', topic: 'valuation', urls: ['https://x.com/a/status/50'] },
        ]);
        expect(costs.spent('llm')).toBeCloseTo(0.003);
    });

    it('leaves out quiet days and failed calls, so merging keeps the previous storylines', async () => {
        const fetchMock = vi.fn(async () => new Response('upstream error', { status: 502 }));
        vi.stubGlobal('fetch', fetchMock);
        const previous = [{ title: 'Old', summary: 'Old one.', stance: 'neutral' as const, topic: 'other' as const, urls: ['https://x.com/a/status/1'] }];
        const stored = { '2026-11-10': previous, '2026-11-09': previous };
        const costs = new CostTracker(Number.POSITIVE_INFINITY, ['llm']);
        const days = new Map([
            ['2026-11-10', Array.from({ length: 10 }, (_, i) => post(i + 1))],
            ['2026-11-11', Array.from({ length: 7 }, (_, i) => post(i + 100))],
        ]);
        const out = await storylinesForDays(days, ['2026-11-10', '2026-11-11'], { model: 'm', costs });
        expect(fetchMock).toHaveBeenCalledTimes(2); // two attempts for 11-10, none for the quiet 11-11
        expect(out).toEqual({});
        expect({ ...stored, ...out }['2026-11-10']).toBe(previous);
    });
});
