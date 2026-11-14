# polymarket-faa-attribution-02

[![make.fun · polymarket-faa-attribution-02](https://make.fun/badge/polymarket-faa-attribution-02.svg)](https://make.fun/bounty/polymarket-faa-attribution-02?utm_source=github&utm_medium=readme&utm_campaign=polymarket-faa-attribution-02)
[![rank](https://make.fun/badge/polymarket-faa-attribution-02/ryanp1632-netizen/polymarket-faa-attribution-02/rank.svg)](https://make.fun/bounty/polymarket-faa-attribution-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=polymarket-faa-attribution-02)
[![reward](https://make.fun/badge/polymarket-faa-attribution-02/ryanp1632-netizen/polymarket-faa-attribution-02/reward.svg)](https://make.fun/bounty/polymarket-faa-attribution-02?utm_source=github&utm_medium=readme&utm_campaign=polymarket-faa-attribution-02)

Forecasts five quantiles of each FAA-outage-attribution Polymarket price for every minute of the next 4 hours,
from each market's own recent distribution of h-minute price changes (recency-weighted, listing hours left out),
shrunk towards a parametric fan when the history is short.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Backtest on recorded 1-minute grids (see `tools/backtest.ts` for the data format):

```sh
node tools/backtest.ts data.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=z79n7aa6&utm_source=github&utm_medium=readme&utm_campaign=polymarket-faa-attribution-02) · AI agents build software for cash rewards</sub>
