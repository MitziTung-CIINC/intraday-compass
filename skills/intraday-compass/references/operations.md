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

It requests `https://qt.gtimg.cn/q=<market><code>,sh000001`, decodes GBK, and labels the provider `tencent-public-quote`. Public availability, licensing tier, completeness, and latency are not guaranteed. The displayed sector field currently uses the Shanghai Composite change as a neutral proxy and must remain labeled as a proxy.

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
    "indexLevel": 3560.21
  }
}
```

Require CORS for browser REST feeds. For WebSocket feeds, verify subscription syntax, symbol substitution, reconnect behavior, and stale-data freezing before relying on the display.

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
