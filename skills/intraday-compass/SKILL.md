---
name: intraday-compass
description: Install, run, validate, troubleshoot, and maintain the Intraday Compass open-source A-share and exchange-traded ETF tracker. Use when Codex needs to clone or update MitziTung-CIINC/intraday-compass, start its local quote bridge and web app, configure a user's six-digit security code and holdings, connect a REST or WebSocket quote feed, record manual real trades, or analyze completed intraday T-trading cycles and cost reduction.
---

# Intraday Compass

Operate the local, read-only Intraday Compass application without connecting to a broker or placing orders.

## Resolve the project

1. Use an existing checkout when the user provides one.
2. Otherwise clone `https://github.com/MitziTung-CIINC/intraday-compass.git` into the user-approved destination.
3. Treat a folder as the application root only when it contains `package.json`, `tools/realtime_quote_bridge.mjs`, and `app/MarketCopilot.tsx`.
4. Run the bundled validator before changing or starting an unfamiliar checkout:

```bash
node <skill-dir>/scripts/verify-project.mjs <project-root>
```

## Install and start

Require Node.js 22 or newer. From the application root, run:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run local
```

On Windows, `start-local.cmd` is the user-facing shortcut. On macOS or Linux, use `./start-local.sh`. Verify both `http://localhost:8765/health` and `http://localhost:4173/`. Keep both services bound to localhost unless the user explicitly asks for a reviewed network deployment.

## Configure tracking

- Accept a security name and six-digit A-share or exchange-traded ETF code.
- Let the application infer SH, SZ, or BJ, then verify the result shown in the UI.
- Record shares, currently sellable shares, holding cost, and optional notes only when the user supplies them.
- Default to T+1. Select T+0 only when the user has independently confirmed that the specific ETF supports same-day turnover.
- Never add example holdings that could be mistaken for the user's real position.

## Verify quote data

Check the bridge health endpoint before diagnosing the UI. The bundled bridge requires no API key: it uses Eastmoney's public snapshot for the low-latency latest-price channel, `trends2` for the instrument and broad-market index minute series, and `kline` for at least 20 daily bars. Stocks also use the industry name returned by the snapshot and the matching public industry-board minute series. ETF tracking-index mapping is not inferred from a paid service; when it is unavailable, the auxiliary comparison is marked unavailable without freezing the instrument/index model. The bridge caches latest prices for 600 ms and refreshes minute context every 5 seconds by default.

Require `meta.validation.passed: true` before treating B/S research signals as active. Missing instrument/index/daily context, stale source timestamps, API errors, or excessive snapshot-to-minute price divergence must freeze B/S judgement while leaving the latest-price display available. Industry or ETF tracking-index minute data is auxiliary and must be visibly marked unavailable without freezing the model. Distinguish `sourceTime`, `receivedAt`, minute-bar time, and request latency; do not describe any of them as exchange-grade market-data latency.

Separate early observation from executable confirmation. Aggregate volume only from completed 5-minute bars, use the first bar of the current same-direction wave as volume 1, and emit an S/B candidate when price extends while later volume falls to 0.70 or lower (0.50 is the optional stricter setting). Score position/support 25, stock/index environment 20, VWAP structure 20, 5-minute wave volume 20, and 1/5-minute nine-turn resonance 15. A matching volume candidate can enter watch at 55; other watches start at 60. Confirmation still requires 75+ and every hard gate: valid data, inventory/turnaround eligibility, clear direction, expected spread covering costs, and the allowed execution window. Watch states must recommend zero shares. MACD and sector data are auxiliary only. New cycles stop at 14:45; an existing cycle may request the opposite action for same-day closure, but never bypass the valid-data gate.

When the user supplies a feed, configure the app's REST or WebSocket mode and verify its JSON mapping against [references/operations.md](references/operations.md). Do not transmit feed tokens, brokerage credentials, or holdings to unrelated services.

## Record and analyze trades

- Treat “真实成交” as a manual journal entry copied from the user's broker confirmation, never as an order.
- Include fees when the user provides them.
- Calculate T-trading success only from closed buy/sell cycles for the same security.
- Separate realized cost reduction from floating profit or loss and report incomplete cycles separately.
- State assumptions when matching multiple fills or partial quantities.

## Troubleshoot and maintain

Read [references/operations.md](references/operations.md) for ports, persistence, quote schema, checks, and failure routing. Preserve user data and unrelated worktree changes. Run `pnpm lint` and `pnpm test` after code changes; use a clean temporary checkout when the running local server locks `node_modules` on Windows.

## Safety boundaries

- Keep the tool read-only with respect to brokerage accounts.
- Do not request account numbers, passwords, trading passwords, SMS codes, API secrets, or full broker screenshots.
- Do not promise uninterrupted, licensed, exchange-grade, or zero-delay quotes from a public endpoint.
- Present signals and T-trading statistics as research assistance, not personalized investment advice or guaranteed execution points.
