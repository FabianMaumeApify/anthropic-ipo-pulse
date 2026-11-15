// Copies the tracker history from one store (and its -posts dataset) into another in the logged-in account,
// merging instead of overwriting. The source is only read.
//
//   node scripts/copy-store.mjs <fromStoreName> <toStoreName> [--dry-run]
//   node scripts/copy-store.mjs anthropic-ipo anthropic-ipo-pulse
//
// - baseline: days the target already has are kept; days only in the source are added; on a shared day,
//   platforms the target lacks are filled from the source. Quotes and ticker sentiment are merged the same way.
// - costs: totals, per-step spend and run lists are added together.
// - news-seen: union. meta: the target's is kept.
// - dataset: source posts whose id is not in the target yet are appended.
// The token is read from ~/.apify/auth.json and is never printed.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [from, to] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dryRun = process.argv.includes('--dry-run');
if (!from || !to) throw new Error('Usage: node scripts/copy-store.mjs <fromStoreName> <toStoreName> [--dry-run]');

const auth = JSON.parse(readFileSync(join(homedir(), '.apify', 'auth.json'), 'utf8'));
const token = auth.token ?? auth.profiles?.[auth.activeProfile]?.token;
if (!token) throw new Error('Not logged in: run `apify login` first.');
const headers = { Authorization: `Bearer ${token}` };
const API = 'https://api.apify.com/v2';

async function api(path, init = {}) {
    const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path.split('?')[0]}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

const me = (await api('/users/me')).data.username;
const kvs = async (name) => (await api(`/key-value-stores/${me}~${name}`))?.data;
const ds = async (name) => (await api(`/datasets/${me}~${name}`))?.data;
const src = await kvs(from);
const dst = await kvs(to);
if (!src) throw new Error(`Source store ${me}~${from} not found`);
if (!dst) throw new Error(`Target store ${me}~${to} not found: run the Actor once with "storeName": "${to}" first`);
const rec = (store, key) => api(`/key-value-stores/${store.id}/records/${key}`);
const put = (key, value) =>
    dryRun
        ? Promise.resolve()
        : api(`/key-value-stores/${dst.id}/records/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(value) });

console.log(`${dryRun ? '[dry run] ' : ''}${me}: ${from} (${src.id}) -> ${to} (${dst.id})`);

// baseline
const a = (await rec(src, 'baseline')) ?? { days: {}, quotes: {}, tickerSentiment: {} };
const b = (await rec(dst, 'baseline')) ?? { days: {}, quotes: {}, tickerSentiment: {} };
const days = { ...a.days };
for (const [day, platforms] of Object.entries(b.days ?? {})) days[day] = { ...(a.days?.[day] ?? {}), ...platforms };
const baseline = {
    updatedAt: new Date().toISOString(),
    days,
    quotes: { ...(a.quotes ?? {}), ...(b.quotes ?? {}) },
    tickerSentiment: { ...(a.tickerSentiment ?? {}), ...(b.tickerSentiment ?? {}) },
};
await put('baseline', baseline);
console.log(`baseline: source ${Object.keys(a.days ?? {}).length} days, target ${Object.keys(b.days ?? {}).length}, merged ${Object.keys(days).length}: ${Object.keys(days).sort().join(', ')}`);

// costs
const ca = (await rec(src, 'costs')) ?? { totalUsd: 0, byStep: {}, runs: [] };
const cb = (await rec(dst, 'costs')) ?? { totalUsd: 0, byStep: {}, runs: [] };
const seenRuns = new Set(cb.runs.map((r) => r.runId));
const byStep = { ...cb.byStep };
for (const [k, v] of Object.entries(ca.byStep)) byStep[k] = (byStep[k] ?? 0) + v;
const costs = { totalUsd: ca.totalUsd + cb.totalUsd, byStep, runs: [...ca.runs.filter((r) => !seenRuns.has(r.runId)), ...cb.runs] };
await put('costs', costs);
console.log(`costs: $${ca.totalUsd.toFixed(2)} + $${cb.totalUsd.toFixed(2)} = $${costs.totalUsd.toFixed(2)}`);

// news-seen and meta
const na = (await rec(src, 'news-seen')) ?? [];
const nb = (await rec(dst, 'news-seen')) ?? [];
const news = [...new Set([...na, ...nb])].slice(-5000);
await put('news-seen', news);
console.log(`news-seen: ${news.length} ids`);
if (!(await rec(dst, 'meta'))) {
    const meta = await rec(src, 'meta');
    if (meta) await put('meta', meta);
    console.log('meta: copied from source');
} else console.log('meta: target kept');

// posts dataset
const dsa = await ds(`${from}-posts`);
const dsb = await ds(`${to}-posts`);
if (!dsa) console.log(`dataset ${from}-posts not found, skipped`);
else if (!dsb) console.log(`dataset ${to}-posts not found: it is created by the Actor; skipped`);
else {
    const ids = async (id) => {
        const out = [];
        for (let offset = 0; ; offset += 1000) {
            const items = await api(`/datasets/${id}/items?clean=1&offset=${offset}&limit=1000`);
            out.push(...items);
            if (items.length < 1000) break;
        }
        return out;
    };
    const have = new Set((await ids(dsb.id)).map((p) => p.id));
    const add = (await ids(dsa.id)).filter((p) => !have.has(p.id));
    for (let i = 0; i < add.length && !dryRun; i += 1000) {
        await api(`/datasets/${dsb.id}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(add.slice(i, i + 1000)) });
    }
    console.log(`dataset: target had ${have.size} posts, ${add.length} added from source`);
}
console.log(`${dryRun ? 'Dry run finished, nothing written.' : 'Done.'} Target store ID for the token scope: ${dst.id}`);
