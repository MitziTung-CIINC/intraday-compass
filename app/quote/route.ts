const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8765";

export async function GET(request: Request) {
  const incoming = new URL(request.url);
  const symbol = incoming.searchParams.get("symbol")?.trim() ?? "";
  const market = incoming.searchParams.get("market")?.trim().toUpperCase() ?? "";

  if (!/^\d{6}$/.test(symbol) || !/^(SH|SZ|BJ)$/.test(market)) {
    return Response.json(
      { error: "symbol 必须为 6 位代码，market 必须为 SH、SZ 或 BJ" },
      { status: 400 },
    );
  }

  const bridgeUrl = (process.env.QUOTE_BRIDGE_URL || DEFAULT_BRIDGE_URL).replace(
    /\/$/,
    "",
  );
  const upstream = new URL(`${bridgeUrl}/quote`);
  const session = incoming.searchParams.get("session");
  if (session !== null && !["today", "previous"].includes(session)) {
    return Response.json({ error: "session 仅支持 today 或 previous" }, { status: 400 });
  }
  if (session !== null) {
    upstream.pathname = "/history";
    upstream.searchParams.set("session", session);
  }
  upstream.searchParams.set("symbol", symbol);
  upstream.searchParams.set("market", market);

  try {
    const response = await fetch(upstream, {
      cache: "no-store",
      signal: AbortSignal.timeout(session ? 45_000 : 12_000),
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") || "application/json",
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    return Response.json(
      {
        error: "免费公开行情桥暂不可用",
        detail: error instanceof Error ? error.message : "unknown error",
      },
      { status: 502 },
    );
  }
}
