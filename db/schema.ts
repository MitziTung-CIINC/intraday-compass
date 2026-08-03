import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const actualTrades = sqliteTable("actual_trades", {
  id: text("id").primaryKey(),
  timestamp: integer("timestamp").notNull(),
  time: text("time").notNull(),
  code: text("code").notNull(),
  side: text("side", { enum: ["buy", "sell"] }).notNull(),
  quantity: integer("quantity").notNull(),
  price: real("price").notNull(),
  fee: real("fee").notNull().default(0),
});
