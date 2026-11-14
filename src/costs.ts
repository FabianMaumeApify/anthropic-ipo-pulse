import { log } from 'apify';

/**
 * Standby calls do not create a Run we can read `usageTotalUsd` from, so we estimate them
 * from each Actor's published BRONZE-tier event price. Batch Runs report their real cost.
 */
export const STANDBY_PRICES = {
    financeRecord: 0.0015, // publicmoney/* "Record" event
    newsItem: 0.00075, // publicmoney/* "News item" event
    yahooQuote: 0, // publicmoney/yahoo-finance-scraper is free
} as const;

export class CostTracker {
    readonly byStep: Record<string, number> = {};
    readonly totalBudget: number;
    readonly perStep: number;

    constructor(totalBudget: number, steps: readonly string[]) {
        this.totalBudget = totalBudget;
        this.perStep = totalBudget / steps.length;
    }

    /** Child Runs whose real cost is re-read at the end of the run (PPE charges land late). */
    readonly childRuns: { step: string; runId: string; counted: number }[] = [];

    trackRun(step: string, runId: string, counted: number) {
        this.childRuns.push({ step, runId, counted });
    }

    /** Replace each child Run's provisional cost with its settled usageTotalUsd. */
    async reconcile(readUsage: (runId: string) => Promise<number>) {
        for (const r of this.childRuns) {
            const usd = await readUsage(r.runId);
            if (usd > r.counted) {
                this.add(r.step, usd - r.counted);
                r.counted = usd;
            }
        }
    }

    add(step: string, usd: number) {
        if (!Number.isFinite(usd) || usd <= 0) return;
        this.byStep[step] = (this.byStep[step] ?? 0) + usd;
    }

    spent(step?: string): number {
        if (step) return this.byStep[step] ?? 0;
        return Object.values(this.byStep).reduce((a, b) => a + b, 0);
    }

    /** Remaining budget for a step: min(even share left, total left). */
    remaining(step: string): number {
        return Math.min(this.perStep - this.spent(step), this.totalBudget - this.spent());
    }

    canSpend(step: string, usd: number): boolean {
        const ok = this.remaining(step) >= usd;
        if (!ok) log.warning(`Budget for step "${step}" exhausted ($${this.spent(step).toFixed(4)} spent); stopping it early`);
        return ok;
    }
}
