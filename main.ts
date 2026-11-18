// Washout-turn bot for the BTC 24h race (cbBTC/USDC, 1-minute bars).
// Entry for btc-race-24h-20261118-1444.
//
// Design: buy the turn AFTER a capitulation washout, never the fall itself.
//
// The previous race's winning design (15-min RSI dip-buying: buy RSI < 38,
// sell RSI > 65) scored +17.82 USDC on its own dev window but LOSES -11.88
// on this race's dev window: on a washout day it buys into the falling knife
// three times and stops out. This window (2026-11-17 14:44 UTC ->
// 2026-11-18 14:44 UTC) fell -2.8% on the day: a sharp -2% washout in the
// first two hours, a flat base, then a +2% recovery rally, then a second leg
// down. The money is the single washout -> recovery move, and the entry must
// wait for the turn:
//
//   - 5-minute bars built from the 1-minute closes (a 15-minute RSI is too
//     slow: it only becomes computable 3h45m in, after the washout is over).
//   - Running high = highest 5-minute close so far this window.
//   - Buy when ALL of these hold: the latest 5-minute close is at least
//     1.5% below the running high (the washout), RSI(14) over the 5-minute
//     closes is below 35 (still oversold), and the latest 5-minute bar is
//     up (the first green bar off the low - the turn).
//   - Exit on a 2.0% take-profit or a 1.0% stop-loss from the entry fill.
//     No RSI exit: on a 5-minute clock RSI > 65 fires on noise and sells
//     into the first small bounce instead of riding the rally.
//   - After a losing exit, sit out 60 bars before buying again.
//   - If equity ever falls 10% under the start, stop opening new trades.
//
// Validated with the kit's grade-local (--driver process) on TWO dev
// windows, the only two 24h windows available:
//   - this race (20261118-1444): net +18.45 USDC, 1 round trip, win rate 1.0,
//     max drawdown 0.67% (dev board #1 is +24.10, #10 is +13.80).
//   - previous race (20261117-0603): net +17.30 USDC, 1 round trip,
//     win rate 1.0, max drawdown 0.66% (the old RSI design scored +17.82
//     there, so this design matches it on a range-bound day and beats it
//     by ~30 USDC on a washout day).
// One trade per day, full stake, fees ~0.8 USDC. The thresholds sit close
// to the observed extremes of the two windows (RSI < 32 never fires on the
// new window; a 1.6% drop never fires on the old one), so this is a
// two-sample fit, not a guarantee: on a live day with no washout it trades
// nothing, and on a washout with no recovery it stops out near -1%.
//
// Everything is float64 on the closes alone: no clock, no environment, no
// randomness, so the two grading runs produce identical action logs.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** One slow bar is this many 1-minute bars. */
const SLOW_BARS = 5;
/** RSI lookback, in slow bars. */
const RSI_N = 14;
/** Buy only while RSI is below this (oversold). */
const RSI_BUY = 35;
/** No RSI exit: 100 means the RSI sell never fires; exits are TP/SL only. */
const RSI_SELL = 100;
/** Stop-loss and take-profit, as fractions of the entry fill price. */
const STOP_LOSS = 0.01;
const TAKE_PROFIT = 0.02;
/** Bars to sit out after a losing exit (60 minutes). */
const COOLDOWN_BARS = 60;
/** Stop opening new trades once equity is this far under the start. */
const HALT_DD = 0.1;
/** Slippage cap per order, in bps (max 1-minute move seen on dev: 45 bps). */
const MAX_SLIPPAGE_BPS = 100;
/** Buy only when the slow close is this far below the running high. */
const DROP_PCT = 0.015;
/** Turn confirmation: this many consecutive up slow bars. */
const TURN_BARS = 1;

/** 5-minute closes, in raw price units. */
const slowCloses: number[] = [];
/** How many 1-minute batches have been answered. */
let seen = 0;
/** The fill price of the open position, in raw price units (0 when flat). */
let entryPrice = 0;
/** Bar index of the last losing sell fill (-1000 = never). */
let lastLossBar = -1000;
/** True once an exit condition has fired and the sell is being retried. */
let exiting = false;
/** True once equity has fallen HALT_DD under the start: no new entries. */
let halted = false;
/** Starting equity, in quote units. */
let startEquity = 0n;
/** Highest slow close so far this window (the washout is measured from it). */
let runningHigh = 0;

/** RSI over the last RSI_N slow closes, simple average of gains and losses. */
function rsi(): number | null {
  const n = slowCloses.length;
  if (n < RSI_N + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = n - RSI_N; i < n; i++) {
    const d = slowCloses[i]! - slowCloses[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= RSI_N;
  loss /= RSI_N;
  if (loss === 0) return 100;
  if (gain === 0) return 0;
  return 100 - 100 / (1 + gain / loss);
}

await runBars({
  onHello(state) {
    startEquity = BigInt(state.hello.capital.quote_units);
  },

  onBatch(state: BarsState, batch: Batch) {
    // Learn from the fills of the orders decided on the previous batch.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || fill.symbol !== SYMBOL) continue;
      if (fill.side === 'buy') {
        entryPrice = Number(fill.price);
      } else if (fill.side === 'sell') {
        if (entryPrice > 0 && Number(fill.price) < entryPrice) lastLossBar = state.seq;
        entryPrice = 0;
        exiting = false;
      }
    }

    const held = state.positions.get(SYMBOL);
    if (held === undefined) {
      entryPrice = 0;
      exiting = false;
    }

    // Halt new entries once equity is HALT_DD under the start.
    if (!halted && state.equity < (startEquity * BigInt(Math.round((1 - HALT_DD) * 100))) / 100n) {
      halted = true;
    }

    // Build the slow bars: every SLOW_BARS-th CBBTC bar closes one. Counting
    // bars, not batches, so a minute with no CBBTC bar cannot swallow a close.
    let slowClose: number | null = null;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      seen += 1;
      if (seen % SLOW_BARS === 0) slowClose = Number(bar.c);
    }
    if (slowClose !== null) {
      slowCloses.push(slowClose);
      if (slowClose > runningHigh) runningHigh = slowClose;
    }
    const slowRsi = rsi();

    if (state.warmingUp) return [];

    const close = state.close(SYMBOL);
    const orders: OrderInput[] = [];

    // Exit: RSI overbought (disabled), stop-loss, or take-profit. Once any
    // of them fires, keep selling until the position is gone (a rejected
    // sell is retried).
    if (held !== undefined && close !== null) {
      if (slowRsi !== null && slowRsi > RSI_SELL) exiting = true;
      if (entryPrice > 0 && close <= entryPrice * (1 - STOP_LOSS)) exiting = true;
      if (entryPrice > 0 && close >= entryPrice * (1 + TAKE_PROFIT)) exiting = true;
      if (exiting) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        return orders;
      }
    }

    // Entry: washout + turn. Flat, cooled down, not halted, RSI oversold,
    // close at least DROP_PCT below the running high, and the last
    // TURN_BARS slow bars up.
    if (
      held === undefined &&
      !halted &&
      slowRsi !== null &&
      slowRsi < RSI_BUY &&
      state.seq - lastLossBar > COOLDOWN_BARS &&
      slowCloses.length > RSI_N + 1
    ) {
      const n = slowCloses.length;
      const last = slowCloses[n - 1]!;
      const drop = runningHigh > 0 ? (runningHigh - last) / runningHigh : 0;
      let up = 0;
      for (let i = n - TURN_BARS; i < n; i++) {
        if (slowCloses[i]! > slowCloses[i - 1]!) up += 1;
        else break;
      }
      if (drop >= DROP_PCT && up >= TURN_BARS) {
        const room = state.weightRoom(SYMBOL);
        let amount = state.cash < room ? state.cash : room;
        if (amount >= BigInt(state.hello.fees.min_notional_quote_units) && amount > 0n) {
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      }
    }
    return orders;
  },
});
