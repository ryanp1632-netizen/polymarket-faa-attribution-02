// SPDX-License-Identifier: MIT
// Walk-forward backtest of main.ts on recorded 1-minute grids, scored with the contest's pinball loss.
//
//   node tools/backtest.ts <data.json> [paramsJSON] [--from ISO] [--step 30] [--unlisted n0,n1] [--by-market]
//
// data.json: [{name, start (unix s of the grid's first minute), prices: [...]}] (one price per minute).
// Every `step` minutes a checkpoint: the history is the up-to-72 h before it, the answer the next 240 minutes
// (fewer at the end of the data). Prints the mean loss of the model and of the house baseline.

import { readFileSync } from 'node:fs';
import { DEFAULTS, forecastMarket, TAUS, type Params } from '../main.ts';

const args = process.argv.slice(2);
const data = JSON.parse(readFileSync(args[0], 'utf8')) as { name: string; start: number; prices: number[] }[];
const flag = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const from = flag('--from') ? Date.parse(flag('--from')!) / 1000 : 0;
const to = flag('--to') ? Date.parse(flag('--to')!) / 1000 : Infinity;
const step = Number(flag('--step') ?? 30);
const unlisted = new Set((flag('--unlisted') ?? '').split(',').filter(Boolean));
const byMarket = args.includes('--by-market');
const calibOut = args.includes('--calib');
const tag = (args[0].split(/[\/]/).pop() ?? '').replace('.json', '');
const maxp = Number(flag('--maxp') ?? 1);
const paramSets: Partial<Params>[] = args[1] && !args[1].startsWith('--') ? [].concat(JSON.parse(args[1])) : [{}];

const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
function baseline(prices: number[], horizon: number): number[][] {
  const x = prices[prices.length - 1];
  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) rows.push(Z.map((z) => Math.round(Math.min(1, Math.max(0, x + z * 0.0025 * Math.sqrt(h))) * 1e6) / 1e6));
  return rows;
}

const calib = { below: [0, 0, 0, 0, 0], loss: [0, 0, 0, 0, 0], n: 0 };
function pinball(q: number[][], ys: number[]): { sum: number; n: number } {
  let sum = 0, n = 0;
  for (let h = 0; h < ys.length; h++) {
    const y = ys[h];
    for (let j = 0; j < 5; j++) {
      const d = y - q[h][j];
      const l = 100 * Math.max(TAUS[j] * d, (TAUS[j] - 1) * d);
      sum += l;
      n++;
      if (track) { calib.loss[j] += l; if (y < q[h][j]) calib.below[j]++; else if (y === q[h][j]) calib.below[j] += 0.5; }
    }
  }
  return { sum, n };
}

let track = false;
type Model = (prices: number[], listed: boolean, atMin: number) => number[][];
function run(model: Model) {
  let sum = 0, n = 0, cases = 0;
  const per: Record<string, { sum: number; n: number }> = {};
  for (const m of data) {
    const listed = !unlisted.has(m.name);
    const minIdx = listed ? 240 : 1440;
    for (let c = minIdx; c < m.prices.length - 1; c += step) {
      const at = m.start + c * 60;
      if (at < from || at > to) continue;
      const lo = Math.max(0, c - 4319);
      const hist = m.prices.slice(lo, c + 1);
      if (hist[hist.length - 1] > maxp) continue;
      const ys = m.prices.slice(c + 1, c + 241);
      const q = model(hist, listed && lo === 0, at / 60);
      const r = pinball(q, ys);
      sum += r.sum; n += r.n; cases++;
      (per[m.name] ??= { sum: 0, n: 0 }).sum += r.sum;
      per[m.name].n += r.n;
    }
  }
  return { loss: sum / n, cases, per };
}

const b = run((p) => baseline(p, 240));
console.log(`${tag} baseline ${b.loss.toFixed(6)} (${b.cases} market-cases)`);
for (const ps of paramSets) {
  // {"ens": [{...}, {...}]} averages the quantiles of several parameter sets
  const members = ((ps as { ens?: Partial<Params>[] }).ens ?? [ps]).map((e) => ({ ...DEFAULTS, ...e }));
  track = calibOut; calib.below.fill(0); calib.loss.fill(0); calib.n = 0;
  const r = run((pr, listed, atMin) => {
    const qs = members.map((p) => forecastMarket(pr, listed, 240, p, atMin));
    return qs[0].map((row, h) => row.map((_, j) => qs.reduce((s, q) => s + q[h][j], 0) / qs.length));
  });
  track = false;
  console.log(`${tag} model ${r.loss.toFixed(6)} ${JSON.stringify(ps)}`);
  if (calibOut) { const N = r.cases * 240; console.log('  P(y<q) ' + calib.below.map((b) => (b / N).toFixed(3)).join(' ') + ' | loss share ' + calib.loss.map((l) => (l / N / 5).toFixed(4)).join(' ')); }
  if (byMarket) console.log('  ' + Object.entries(r.per).map(([k, v]) => `${k}:${(v.sum / v.n).toFixed(4)}`).join(' '));
}
if (byMarket) console.log('baseline ' + Object.entries(b.per).map(([k, v]) => `${k}:${(v.sum / v.n).toFixed(4)}`).join(' '));
