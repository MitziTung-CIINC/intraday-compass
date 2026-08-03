import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "分时罗盘",
  description: "输入自己的A股或场内ETF持仓，进行只读分时监测与日内做T复盘。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
