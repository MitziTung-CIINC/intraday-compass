import type { SignalReading, SignalState, Tick } from "./t0Model";

export type StopWatchConfig = {
  enabled: boolean;
  deviceUrl: string;
};

export type StopWatchHolding = {
  code: string;
  name: string;
  market: "SH" | "SZ" | "BJ";
  price: number;
  previousClose: number;
};

export type StopWatchStatePayload = {
  version: 1;
  event_id: string;
  updated_at: string;
  realtime: boolean;
  active_index: number;
  active_code: string;
  holdings: Array<{
    code: string;
    name: string;
    market: "SH" | "SZ" | "BJ";
    price: number;
    change_pct: number;
  }>;
  candles: Array<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
  }>;
  signal_state: SignalState;
  b_score: number;
  s_score: number;
  remaining_gates: number;
};

export const DEFAULT_STOPWATCH_CONFIG: StopWatchConfig = {
  enabled: false,
  deviceUrl: "http://intraday-compass.local",
};

export function normalizeStopWatchUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function finite(value: number | undefined, fallback: number) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

export function buildStopWatchState({
  holdings,
  selectedCode,
  ticks,
  signal,
  realtime,
  now = new Date(),
}: {
  holdings: StopWatchHolding[];
  selectedCode: string;
  ticks: Tick[];
  signal: SignalReading;
  realtime: boolean;
  now?: Date;
}): StopWatchStatePayload {
  const activeIndex = Math.max(
    0,
    holdings.findIndex((holding) => holding.code === selectedCode),
  );
  const eventTime = ticks.at(-1)?.time || now.toISOString();
  const candles = ticks
    .filter((tick) => Number.isFinite(tick.price))
    .slice(-18)
    .map((tick) => {
      const close = tick.price;
      const open = finite(tick.open, close);
      return {
        time: tick.time,
        open,
        high: finite(tick.high, Math.max(open, close)),
        low: finite(tick.low, Math.min(open, close)),
        close,
      };
    });

  return {
    version: 1,
    event_id: `${selectedCode}-${signal.state}-${eventTime}`,
    updated_at: now.toISOString(),
    realtime,
    active_index: activeIndex,
    active_code: selectedCode,
    holdings: holdings.slice(0, 8).map((holding) => ({
      code: holding.code,
      name: holding.name.replace(/^示例：/, ""),
      market: holding.market,
      price: finite(holding.price, 0),
      change_pct:
        holding.previousClose > 0
          ? (holding.price / holding.previousClose - 1) * 100
          : 0,
    })),
    candles,
    signal_state: signal.state,
    b_score: Math.round(signal.bScore),
    s_score: Math.round(signal.sScore),
    remaining_gates: signal.hardGates.filter((gate) => !gate.passed).length,
  };
}

async function deviceFetch(
  config: StopWatchConfig,
  apiKey: string,
  path: string,
  init: RequestInit = {},
) {
  const deviceUrl = normalizeStopWatchUrl(config.deviceUrl);
  if (!deviceUrl) throw new Error("请填写 StopWatch 地址");
  const headers = new Headers(init.headers);
  headers.set("X-API-Key", apiKey);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${deviceUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) {
    throw new Error(`StopWatch HTTP ${response.status}`);
  }
  return response;
}

export async function pushStopWatchState(
  config: StopWatchConfig,
  apiKey: string,
  payload: StopWatchStatePayload,
) {
  const response = await deviceFetch(config, apiKey, "/state", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return response.json() as Promise<{ status: string }>;
}

export async function readStopWatchSelection(
  config: StopWatchConfig,
  apiKey: string,
) {
  const response = await deviceFetch(config, apiKey, "/selection");
  return response.json() as Promise<{
    selected_index: number;
    selected_code: string;
  }>;
}

export async function testStopWatchConnection(config: StopWatchConfig) {
  const deviceUrl = normalizeStopWatchUrl(config.deviceUrl);
  if (!deviceUrl) throw new Error("请填写 StopWatch 地址");
  const response = await fetch(`${deviceUrl}/health`, {
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error(`StopWatch HTTP ${response.status}`);
  return response.json() as Promise<{ status: string; ip: string }>;
}
