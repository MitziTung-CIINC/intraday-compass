# Operations reference

## Canonical project

- Repository: `https://github.com/MitziTung-CIINC/intraday-compass`
- Runtime: Node.js 22+, pnpm 11.9.0
- Web app: `http://localhost:4173/`
- Quote bridge: `http://127.0.0.1:8765/`
- Health check: `http://localhost:8765/health`

## Start and verify

1. Run `corepack pnpm install --frozen-lockfile`.
2. Run `corepack pnpm run local` or the platform shortcut.
3. Require the health endpoint to return `ok: true`.
4. Query `/quote?symbol=600519&market=SH` only as a connectivity check; do not save it as a user's holding.
5. Open the web app and confirm the selected security, source time, receive time, and quote status.
6. Run `pnpm lint` and `pnpm test` after implementation changes.

## Bundled quote bridge

The bridge binds to `127.0.0.1` by default. Override only with reviewed environment variables:

- `T0_QUOTE_BRIDGE_HOST`
- `T0_QUOTE_BRIDGE_PORT`
- `EASTMONEY_CONTEXT_REFRESH_MS` (default `5000`)
- `EASTMONEY_DAILY_REFRESH_MS` (default `21600000`)
- `EASTMONEY_MAPPING_REFRESH_MS` (default `86400000`)
- `EASTMONEY_MINUTE_MAX_AGE_MS` (default `90000`)
- `EASTMONEY_PRICE_TOLERANCE_PCT` (default `1`)
- `T0_LATEST_MAX_AGE_MS` (default `15000`)

The bridge requires no API key. The latest-price channel requests Eastmoney `stock/get` and labels the source `eastmoney-official-snapshot`. The minute channel requests Eastmoney `stock/trends2/get` for the instrument and matching broad-market index; stocks also request the actual industry board. Multi-day structure uses Eastmoney `stock/kline/get`. The bridge aligns context bars by the latest timestamp at or before each instrument minute and returns them in `data.minuteBars`. ETF tracking-index mapping is not guessed when the public endpoints do not provide it; that auxiliary series is marked unavailable. Public availability, licensing tier, completeness, and latency are not guaranteed. Never substitute an index snapshot for missing industry history.

The bridge returns a required `meta.validation` object. Only `passed: true` enables live B/S research signals. Missing instrument/index/daily context, a minute bar older than 90 seconds, a latest quote older than 15 seconds, or a snapshot-to-minute price divergence over 1% freezes B/S judgement. Industry or ETF tracking-index context is auxiliary and may be unavailable without freezing the model. These thresholds can be tuned with the environment variables above after measuring actual source behavior.

## Custom feed contract

The default REST mapping accepts this shape:

```json
{
  "data": {
    "price": 33.82,
    "previousClose": 33.5,
    "volume": 152600,
    "time": "2026-08-03T10:31:00+08:00",
    "sectorChange": -0.42,
    "indexChange": -0.18,
    "indexLevel": 3560.21,
    "minuteBars": [
      {
        "time": "2026-08-03T10:31:00+08:00",
        "open": 33.8,
        "close": 33.82,
        "high": 33.85,
        "low": 33.78,
        "volume": 152600,
        "amount": 5160232,
        "sectorChange": -0.42,
        "indexChange": -0.18
      }
    ],
    "dailyBars": [],
    "context": {
      "indexSeriesValid": true,
      "sectorSeriesValid": true,
      "dailySeriesValid": true
    }
  },
  "meta": {
    "validation": {
      "passed": true,
      "status": "passed",
      "reason": "东方财富官方快照、分钟 K 线和市场上下文校验通过"
    }
  }
}
```

Require CORS for browser REST feeds. For WebSocket feeds, verify subscription syntax, symbol substitution, reconnect behavior, and stale-data freezing before relying on the display.

## Licensed L2 feeds

Retail desktop or mobile Level-2 membership is not evidence of API entitlement. Connect only an official API, SDK, or gateway whose agreement permits the intended display or non-display use. Do not scrape, hook, decrypt, or reuse client credentials.

Use direct browser REST/WebSocket configuration only for CORS-enabled Bearer-token feeds with compatible fields. Direct REST polling has a one-second minimum, and a scalar-only feed can update the displayed price but cannot enable the complete model without `minuteBars`, `dailyBars`, context series, and `meta.validation`.

For Eastmoney Choice, Tonghuashun data interfaces, or broker-specific signed/SDK feeds, prefer a local adapter bound to `127.0.0.1`. Keep provider credentials in the adapter environment, normalize the provider payload into the custom feed contract above, restrict CORS to `http://localhost:4173`, and fail closed when validation cannot be proven. Never commit tokens or paid market data.

The user-facing end-to-end guide is [`docs/l2-market-data-integration.md`](../../../docs/l2-market-data-integration.md).

## Persistence

- Holdings and feed configuration use browser `localStorage` keys `t0-holdings`, `t0-feed-config-v3`, and `t0-wave-guide`.
- Manual real trades use the local `/api/trades` database route.
- Clearing site data or deleting the project can remove local records. Back up only with the user's permission and never commit holdings or trades to Git.

## Failure routing

- Health endpoint fails: inspect the quote-bridge process and port 8765.
- Health passes but quotes fail: inspect the six-digit code, inferred market, upstream timeout, and source timestamp.
- Quotes pass but UI is stale: inspect feed mode, browser console, polling state, and stale-data indicator.
- Install reports `ERR_PNPM_IGNORED_BUILDS`: retain the reviewed `allowBuilds` map in `pnpm-workspace.yaml`; do not enable `dangerouslyAllowAllBuilds`.
- Windows clean install hangs while the app is running: validate in a temporary checkout rather than deleting the active `node_modules`.
