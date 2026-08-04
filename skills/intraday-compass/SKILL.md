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

Check the bridge health endpoint before diagnosing the UI. The bundled bridge queries Tencent's public quote endpoint, caches for 600 ms, and times out upstream requests after 3 seconds. Distinguish `sourceTime`, `receivedAt`, and request latency; do not describe request latency as exchange-grade market-data latency.

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
