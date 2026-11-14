// SPDX-License-Identifier: MIT
// Forecaster for make.fun's polymarket-faa-attribution-02: five quantiles of each market's Yes price at every
// minute of the 4 hours after a checkpoint (Node 22, standard library only, deterministic, no network).
//
// Model: for each market, the empirical distribution of its own h-minute price changes over its recent history
// (pairs weighted by recency), read at the five levels for a grid of horizons and interpolated in sqrt(h), shrunk
// towards a parametric fan when the history is short. The first minutes after a market's listing (price discovery)
// are left out. The centre is the last price, pulled part of the way towards a short recent level to undo
// bid/ask bounce.
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TAUS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];

export interface Params {
  skipListing: number; // minutes after a market's first price left out of the change statistics
  halfLife: number; // recency half-life of a change pair, in minutes
  lookback: number; // at most this many minutes of history are used
  revert: number; // share of the gap between the last price and the recent level closed by the centre
  levelWin: number; // minutes in the recent level (a median)
  priorSigma: number; // parametric fan: price units per sqrt(minute) at a price of 0.03
  priorK: number; // pseudo-pairs given to the parametric fan
  widen: number; // multiplier on every quantile offset
  driftKeep: number; // share of the history's median h-minute change kept as drift (0: the fan is centred)
}

export const DEFAULTS: Params = {
  skipListing: 360,
  halfLife: 240,
  lookback: 4320,
  revert: 0,
  levelWin: 30,
  priorSigma: 0.0005,
  priorK: 200,
  widen: 0.8,
  driftKeep: 0,
};

const H_GRID = [1, 2, 3, 5, 8, 12, 17, 25, 35, 50, 70, 100, 140, 190, 240];

/**
 * Weighted quantiles of values v (weights w) at the five levels. Prices move in half-tick steps, so the changes take
 * few distinct values: they are pooled by value (to 1e-7) and only the distinct values are sorted.
 */
function wquantiles(v: number[], w: number[]): number[] {
  const pool = new Map<number, number>();
  let total = 0;
  for (let i = 0; i < v.length; i++) {
    const k = Math.round(v[i] * 1e7);
    pool.set(k, (pool.get(k) ?? 0) + w[i]);
    total += w[i];
  }
  const keys = [...pool.keys()].sort((a, b) => a - b);
  const out: number[] = [];
  let acc = 0, ki = 0;
  for (const tau of TAUS) {
    const target = tau * total;
    while (ki < keys.length - 1 && acc + pool.get(keys[ki])! < target) { acc += pool.get(keys[ki])!; ki++; }
    out.push(keys[ki] / 1e7);
  }
  return out;
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/**
 * Quantile rows for one market. prices: one per minute up to the checkpoint; listed: true when the first price is
 * the market's listing (the history starts inside the 72 h window).
 */
export function forecastMarket(prices: number[], listed: boolean, horizon: number, p: Params = DEFAULTS): number[][] {
  const N = prices.length;
  const x = prices[N - 1];
  let u0 = listed ? Math.min(p.skipListing, Math.max(0, N - 60)) : 0;
  u0 = Math.max(u0, N - p.lookback);
  const g = prices;

  // centre
  const lw = Math.min(p.levelWin, N);
  const level = median(g.slice(N - lw));
  const centre = x + p.revert * (level - x);

  // parametric prior offsets per horizon: a scaled normal fan
  const scale = p.priorSigma * Math.max(0.2, Math.sqrt(Math.max(x, 0.001) / 0.03));

  const offs: number[][] = []; // offs[k][j] for H_GRID[k], tau j
  for (const h of H_GRID) {
    const vals: number[] = [];
    const ws: number[] = [];
    for (let i = u0; i + h <= N - 1; i++) {
      const age = N - 1 - (i + h);
      vals.push(g[i + h] - g[i]);
      ws.push(Math.pow(0.5, age / p.halfLife));
    }
    let sw = 0, sw2 = 0;
    for (const w of ws) { sw += w; sw2 += w * w; }
    const neff = sw2 > 0 ? (sw * sw) / sw2 : 0;
    const row: number[] = [];
    const eq = vals.length ? wquantiles(vals, ws) : null;
    if (eq) { const m = eq[2] * (1 - p.driftKeep); for (let j = 0; j < 5; j++) eq[j] -= m; }
    for (let j = 0; j < 5; j++) {
      const prior = Z[j] * scale * Math.sqrt(h);
      const emp = eq ? eq[j] : prior;
      const a = neff / (neff + p.priorK);
      row.push((a * emp + (1 - a) * prior) * p.widen);
    }
    offs.push(row);
  }

  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) {
    // interpolate in sqrt(h) between grid points
    let k = 0;
    while (k < H_GRID.length - 1 && H_GRID[k + 1] < h) k++;
    let o: number[];
    if (h <= H_GRID[0]) o = offs[0];
    else if (k >= H_GRID.length - 1) o = offs[H_GRID.length - 1];
    else {
      const a = Math.sqrt(H_GRID[k]), b = Math.sqrt(H_GRID[k + 1]);
      const t = (Math.sqrt(h) - a) / (b - a);
      o = offs[k].map((v, j) => v + t * (offs[k + 1][j] - v));
    }
    const row = o.map((d) => Math.min(1, Math.max(0, centre + d)));
    for (let j = 1; j < 5; j++) if (row[j] < row[j - 1]) row[j] = row[j - 1];
    rows.push(row.map((v) => Math.round(v * 1e6) / 1e6 + 0));
  }
  return rows;
}

interface CaseMarket { id: string; start: string; prices: number[] }
interface Case { at: string; horizon_minutes: number; quantiles: number[]; markets: CaseMarket[] }

export function forecastCase(c: Case, p: Params = DEFAULTS): { id: string; q: number[][] }[] {
  const atMs = Date.parse(c.at);
  return c.markets.map((m) => {
    const listed = Date.parse(m.start) > atMs - 4320 * 60000 + 60000;
    return { id: m.id, q: forecastMarket(m.prices, listed, c.horizon_minutes, p) };
  });
}

function main(): void {
  const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
  for (const file of inputs) {
    const id = file.slice(0, -'.in'.length);
    const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
    const forecasts = forecastCase(c);
    writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
  }
}

if (process.argv[1] && /main\.ts$/.test(process.argv[1])) main();
