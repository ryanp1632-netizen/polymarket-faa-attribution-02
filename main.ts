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
  hlPerH: number; // the half-life grows by this many minutes per minute of horizon (long horizons need more pairs)
  widenOut: number; // extra multiplier on the 5% and 95% offsets
  widenIn: number; // extra multiplier on the 25% and 75% offsets
  diurnalA: number; // amplitude of the time-of-day activity profile (0: off)
  diurnalPeak: number; // UTC hour of peak activity
  diurnalPow: number; // offsets scale as (activity ahead / activity in the history) ^ this
  relPow: number; // a past change is scaled by (price now / price then) ^ this (0: absolute changes)
  relFloor: number; // prices below this count as this in that ratio
  snap: number; // round each offset to a multiple of this (0: off); midpoints live on a 0.0005 grid
  widenH: number; // the width multiplier also scales as (h / 60) ^ this
  clusterHL: number; // half-life (minutes) of the short activity window
  clusterPow: number; // offsets scale as (short activity / long activity) ^ (this * tau / (tau + h)); 0: off
  clusterTau: number; // horizon (minutes) over which the clustering effect fades to half
}

export const DEFAULTS: Params = {
  skipListing: 360,
  halfLife: 1440,
  lookback: 4320,
  revert: 0.2,
  levelWin: 10,
  priorSigma: 0.0005,
  priorK: 200,
  widen: 0.8,
  driftKeep: 0,
  hlPerH: 0,
  widenOut: 1,
  widenIn: 1,
  diurnalA: 0,
  diurnalPeak: 17,
  diurnalPow: 1,
  relPow: 0.5,
  relFloor: 0.01,
  snap: 0.0005,
  widenH: 0,
  clusterHL: 30,
  clusterPow: 0.9,
  clusterTau: 360,
};
const WJ = (p: Params) => [p.widenOut, p.widenIn, 1, p.widenIn, p.widenOut];

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
export function forecastMarket(prices: number[], listed: boolean, horizon: number, p: Params = DEFAULTS, atMin?: number): number[][] {
  const N = prices.length;
  // time-of-day activity profile: f(t) = 1 + A cos(2 pi (hourUTC - peak) / 24), t in unix minutes
  const useDiurnal = atMin !== undefined && p.diurnalA !== 0;
  const f = (t: number) => 1 + p.diurnalA * Math.cos((2 * Math.PI * (((t / 60) % 24) - p.diurnalPeak)) / 24);
  const futF: number[] = [0];
  if (useDiurnal) { let acc = 0; for (let k = 1; k <= 240; k++) { acc += f(atMin! + k); futF.push(acc / k); } }
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

  // volatility clustering: activity (mean |1-minute change|) over a short recent window against the long one
  let actRatio = 1;
  if (p.clusterPow) {
    let sS = 0, wS = 0, sL = 0, wL = 0;
    for (let i = Math.max(u0 + 1, 1); i < N; i++) {
      const age = N - 1 - i;
      const a = Math.abs(g[i] - g[i - 1]);
      const ws_ = Math.pow(0.5, age / p.clusterHL), wl = Math.pow(0.5, age / p.halfLife);
      sS += ws_ * a; wS += ws_; sL += wl * a; wL += wl;
    }
    const eps = 0.00002;
    if (wS > 0 && wL > 0) actRatio = Math.min(3, Math.max(1 / 3, (sS / wS + eps) / (sL / wL + eps)));
  }

  const wj = WJ(p);
  const offs: number[][] = []; // offs[k][j] for H_GRID[k], tau j
  for (const h of H_GRID) {
    const vals: number[] = [];
    const ws: number[] = [];
    const hl = p.halfLife + p.hlPerH * h;
    for (let i = u0; i + h <= N - 1; i++) {
      const age = N - 1 - (i + h);
      const lv = p.relPow ? Math.pow(Math.max(x, p.relFloor) / Math.max(g[i], p.relFloor), p.relPow) : 1;
      vals.push((g[i + h] - g[i]) * lv);
      ws.push(Math.pow(0.5, age / hl));
    }
    let sw = 0, sw2 = 0;
    for (const w of ws) { sw += w; sw2 += w * w; }
    const neff = sw2 > 0 ? (sw * sw) / sw2 : 0;
    let tod = 1;
    if (useDiurnal && ws.length) {
      let fh = 0;
      for (let i = u0, k = 0; i + h <= N - 1; i++, k++) fh += ws[k] * f(atMin! - (N - 1 - i) + h / 2);
      tod = Math.pow(futF[Math.min(h, 240)] / (fh / sw), p.diurnalPow);
    }
    if (p.clusterPow) tod *= Math.pow(actRatio, (p.clusterPow * p.clusterTau) / (p.clusterTau + h));
    const row: number[] = [];
    const eq = vals.length ? wquantiles(vals, ws) : null;
    if (eq) { const m = eq[2] * (1 - p.driftKeep); for (let j = 0; j < 5; j++) eq[j] -= m; }
    for (let j = 0; j < 5; j++) {
      const prior = Z[j] * scale * Math.sqrt(h);
      const emp = eq ? eq[j] : prior;
      const a = neff / (neff + p.priorK);
      row.push((a * emp + (1 - a) * prior) * p.widen * Math.pow(h / 60, p.widenH) * wj[j] * tod);
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
    const row = o.map((d) => {
      let v = centre + d;
      if (p.snap > 0) v = centre + Math.round(d / p.snap) * p.snap;
      return Math.min(1, Math.max(0, v));
    });
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
    return { id: m.id, q: forecastMarket(m.prices, listed, c.horizon_minutes, p, Math.round(atMs / 60000)) };
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
