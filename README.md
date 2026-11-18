# Washout-turn cbBTC bot — btc-race-24h-20261118-1444

![bounty](https://make.fun/api/competitions/btc-race-24h-20261118-1444/badge/bounty)
![rank](https://make.fun/api/competitions/btc-race-24h-20261118-1444/badge/rank)
![reward](https://make.fun/api/competitions/btc-race-24h-20261118-1444/badge/reward)

A mean-reversion bot for the 24-hour BTC race: it trades Coinbase Wrapped BTC
(cbBTC) on 1-minute on-chain prices with $1,000 of paper money.

## Strategy

Buy the turn **after** a capitulation washout — never the fall itself:

- 5-minute bars; RSI(14) over them; running high = highest 5-minute close
  so far this window.
- **Buy** the whole stake when the close is ≥1.5% below the running high,
  RSI < 35, and the latest 5-minute bar is up (first green bar off the low).
- **Sell** on a 2.0% take-profit or a 1.0% stop-loss. No RSI exit: on a
  5-minute clock RSI > 65 fires on noise and sells the first small bounce.
- 60-bar cooldown after a losing exit; no new entries if equity falls 10%.

Why not plain dip-buying: the previous race's 15-minute RSI dip-buyer scored
+17.82 USDC on its own window but −11.88 USDC on this race's dev window — a
washout day makes it buy the falling knife three times. The washout-turn
design fixes that by waiting for the turn.

## Validation (kit grade-local, --driver process)

| dev window | net PnL | trades | win rate | max drawdown |
|---|---|---|---|---|
| 20261118-1444 (this race) | +18.45 USDC | 2 (1 round trip) | 1.0 | 0.67% |
| 20261117-0603 (previous race) | +17.30 USDC | 2 (1 round trip) | 1.0 | 0.66% |

Dev board for this race: #1 +24.10, #10 +13.80 (43 entries). One trade per
day, full stake. Honest caveat: the thresholds sit close to the observed
extremes of the two known windows, so this is a two-sample fit — on a live
day with no washout it trades nothing, and on a washout with no recovery it
stops out near −1%.

## Run

```sh
node --experimental-strip-types main.ts
```

Node 22, standard library only; the `vendor/` file is the kit's bars SDK.
No network, no wall clock, no randomness — two runs on the same data produce
identical orders.

## License

MIT — see `LICENSE`.
