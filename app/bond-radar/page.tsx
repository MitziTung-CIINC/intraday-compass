import type { Metadata } from "next";
import { headers } from "next/headers";
import initialSnapshot from "../../public/data/bond-radar.json";
import BondRadarDashboard, {
  type BondRadarSnapshot,
} from "./BondRadarDashboard";

const title = "转债同步雷达｜向上联动 Top 10";
const description =
  "以上一交易日收盘价为基准，综合有效波动、量能、动量和联动弹性，筛选10组A股可转债与正股并比较分钟级同步率。";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:4173";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");
  const image = `${protocol}://${host}/og.png`;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      images: [{ url: image, width: 1733, height: 909, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}

export default function BondRadarPage() {
  return (
    <BondRadarDashboard
      initialSnapshot={initialSnapshot as BondRadarSnapshot}
    />
  );
}
