import type { Metadata } from "next";
import MarketCopilot from "./MarketCopilot";

export const metadata: Metadata = {
  title: "分时罗盘",
  description: "可自定义A股与场内ETF持仓的只读分时监测与日内做T复盘工具。",
};

export default function Home() {
  return <MarketCopilot />;
}
