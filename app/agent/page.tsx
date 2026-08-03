import type { Metadata } from "next";
import BacktestAgent from "./BacktestAgent";

export const metadata: Metadata = {
  title: "成功率评测 Agent | 分时罗盘",
  description: "本地逐分钟回放分时罗盘模型，审计B/S周期与扣费后成功率。",
};

export default function AgentPage() {
  return <BacktestAgent />;
}
