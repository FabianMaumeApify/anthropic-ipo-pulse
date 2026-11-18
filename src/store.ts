import { Actor } from 'apify';

import type { Baseline, CostLedger, LiveSnapshot, TopicTally } from './types.js';

type Kvs = Awaited<ReturnType<typeof Actor.openKeyValueStore>>;

/** Topic tally for the timeline: only topics that occurred, sentiment sums rounded to 3 decimals. */
export function compactTopics(topics: TopicTally | undefined): TopicTally | undefined {
    if (!topics) return undefined;
    return Object.fromEntries(
        Object.entries(topics)
            .filter(([, t]) => t.n > 0)
            .map(([k, t]) => [k, { n: t.n, sentimentSum: Math.round(t.sentimentSum * 1000) / 1000 }]),
    );
}

/**
 * Named storages persist across runs and are what the website reads. `forceCloud` makes local
 * `apify run` tests write to the same platform store the scheduled runs use.
 */
export class TrackerStore {
    private constructor(private readonly kvs: Kvs) {}

    static async open(name: string) {
        return new TrackerStore(await Actor.openKeyValueStore(name, { forceCloud: true }));
    }

    async baseline(): Promise<Baseline> {
        return (
            (await this.kvs.getValue<Baseline>('baseline')) ?? {
                updatedAt: new Date().toISOString(),
                days: {},
                quotes: {},
                tickerSentiment: {},
            }
        );
    }

    async saveBaseline(b: Baseline) {
        b.updatedAt = new Date().toISOString();
        await this.kvs.setValue('baseline', b);
    }

    async saveLive(live: LiveSnapshot, timelineCap = 600) {
        await this.kvs.setValue('live', live);
        const timeline = (await this.kvs.getValue<unknown[]>('live-timeline')) ?? [];
        timeline.push({
            asOf: live.asOf,
            platforms: Object.fromEntries(
                Object.entries(live.platforms).map(([p, a]) => [
                    p,
                    {
                        volume: a.volume,
                        relevant: a.relevant,
                        scored: a.scored,
                        sentimentSum: a.sentimentSum,
                        bull: a.bull,
                        bear: a.bear,
                        topics: compactTopics(a.topics),
                    },
                ]),
            ),
            quotes: live.quotes.map((q) => ({ symbol: q.symbol, price: q.price, changePercent: q.changePercent })),
        });
        await this.kvs.setValue('live-timeline', timeline.slice(-timelineCap));
    }

    async seenNews(): Promise<Set<string>> {
        return new Set((await this.kvs.getValue<string[]>('news-seen')) ?? []);
    }

    async saveSeenNews(seen: Set<string>) {
        await this.kvs.setValue('news-seen', [...seen].slice(-5000));
    }

    async addCosts(runId: string, mode: CostLedger['runs'][number]['mode'], byStep: Record<string, number>) {
        const ledger = (await this.kvs.getValue<CostLedger>('costs')) ?? { totalUsd: 0, byStep: {}, runs: [] };
        let usd = 0;
        for (const [step, v] of Object.entries(byStep)) {
            ledger.byStep[step] = (ledger.byStep[step] ?? 0) + v;
            usd += v;
        }
        ledger.totalUsd += usd;
        ledger.runs.push({ runId, mode, usd, at: new Date().toISOString() });
        ledger.runs = ledger.runs.slice(-500);
        await this.kvs.setValue('costs', ledger);
        return ledger;
    }

    async setMeta(meta: unknown) {
        await this.kvs.setValue('meta', meta);
    }
}
