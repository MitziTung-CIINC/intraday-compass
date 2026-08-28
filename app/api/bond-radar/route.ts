const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8765";

export async function POST() {
  const bridgeUrl = (process.env.QUOTE_BRIDGE_URL || DEFAULT_BRIDGE_URL).replace(
    /\/$/,
    "",
  );
  try {
    const response = await fetch(`${bridgeUrl}/bond-radar`, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
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
        error: "转债雷达实时计算服务暂不可用",
        detail: error instanceof Error ? error.message : "unknown error",
      },
      { status: 502 },
    );
  }
}
