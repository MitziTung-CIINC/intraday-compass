import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { actualTrades } from "../../../db/schema";

async function ensureTradesSchema() {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) {
    throw new Error("本地交易记录数据库未绑定");
  }

  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS actual_trades (
        id TEXT PRIMARY KEY NOT NULL,
        timestamp INTEGER NOT NULL,
        time TEXT NOT NULL,
        code TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        price REAL NOT NULL CHECK (price > 0),
        fee REAL NOT NULL DEFAULT 0 CHECK (fee >= 0)
      )
    `),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS actual_trades_code_time_idx ON actual_trades (code, timestamp DESC)",
    ),
  ]);
}

export async function GET(request: Request) {
  try {
    await ensureTradesSchema();
    const code = new URL(request.url).searchParams.get("code")?.trim();
    const db = await getDb();
    const trades = code
      ? await db
          .select()
          .from(actualTrades)
          .where(eq(actualTrades.code, code))
          .orderBy(desc(actualTrades.timestamp))
          .limit(2000)
      : await db
          .select()
          .from(actualTrades)
          .orderBy(desc(actualTrades.timestamp))
          .limit(2000);

    return Response.json({ trades });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "读取真实成交记录失败",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      id?: string;
      timestamp?: number;
      time?: string;
      code?: string;
      side?: "buy" | "sell";
      quantity?: number;
      price?: number;
      fee?: number;
    };
    const trade = {
      id: payload.id?.trim() ?? "",
      timestamp: Math.floor(Number(payload.timestamp)),
      time: payload.time?.trim() ?? "",
      code: payload.code?.trim() ?? "",
      side: payload.side,
      quantity: Math.floor(Number(payload.quantity)),
      price: Number(payload.price),
      fee: Math.max(0, Number(payload.fee) || 0),
    };

    if (
      !trade.id ||
      !Number.isFinite(trade.timestamp) ||
      trade.timestamp <= 0 ||
      !trade.time ||
      !/^\d{6}$/.test(trade.code) ||
      !trade.side ||
      !["buy", "sell"].includes(trade.side) ||
      !Number.isFinite(trade.quantity) ||
      trade.quantity <= 0 ||
      !Number.isFinite(trade.price) ||
      trade.price <= 0
    ) {
      return Response.json(
        { error: "真实成交记录字段无效" },
        { status: 400 },
      );
    }

    await ensureTradesSchema();
    const db = await getDb();
    await db.insert(actualTrades).values(trade).onConflictDoNothing();
    const [saved] = await db
      .select()
      .from(actualTrades)
      .where(eq(actualTrades.id, trade.id))
      .limit(1);

    return Response.json({ trade: saved }, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "保存真实成交记录失败",
      },
      { status: 500 },
    );
  }
}
