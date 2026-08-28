import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the market copilot shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>分时罗盘<\/title>/i);
  assert.match(html, /只读行情实验台/);
  assert.match(html, /不连接证券账户/);
  assert.match(html, /行情配置/);
  assert.match(html, /东方财富官方行情桥/);
  assert.match(html, /管理持仓/);
  assert.match(html, /示例：贵州茅台/);
  assert.match(html, /真实持仓与做T账本/);
  assert.match(html, /记录真实买入/);
  assert.match(html, /降低成本成功率/);
  assert.match(html, /交易日历依据/);
  assert.match(html, /MACD辅助 \(12,26,9\)/);
  assert.match(html, /课程规则模式/);
  assert.match(html, /消息面风险锁定/);
  assert.match(html, /建议批次/);
  assert.match(html, /硬门槛/);
  assert.match(html, /申万一级行业分钟序列/);
  assert.match(html, /大盘波浪 · 个股空仓指引/);
  assert.match(html, /成功率Agent/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("includes the StopWatch hardware sync controls", async () => {
  const source = await readFile(
    new URL("../app/MarketCopilot.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /StopWatch 硬件同步/);
  assert.match(source, /同步持仓、实时 K 线与 B\/S 成熟提醒/);
  assert.match(source, /testStopWatchConnection/);
  assert.match(source, /readStopWatchSelection/);
});

test("describes convertible bonds as T+0 instruments", async () => {
  const source = await readFile(
    new URL("../app/MarketCopilot.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /T\+0 · 可转债及支持当日回转的ETF/);
  assert.match(source, /可转债按T\+0处理/);
});

test("includes mature B/S popup, sound, and browser permission guidance", async () => {
  const source = await readFile(
    new URL("../app/MarketCopilot.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /playSignalTone/);
  assert.match(source, /\[620, 720, 820\]/);
  assert.match(source, /\[820, 745, 670, 595, 520\]/);
  assert.match(source, /role="alertdialog"/);
  assert.match(source, /开启B\/S弹窗与声音/);
  assert.match(source, /Notification\.requestPermission/);
  assert.match(source, /requireInteraction: true/);
  assert.match(source, /系统通知已开启/);
  assert.match(source, /系统通知需使用 HTTPS/);
  assert.match(source, /无需麦克风、摄像头、位置或券商账户权限/);
  assert.doesNotMatch(source, /\["watchB", "watchS", "confirmB", "confirmS"\]/);
});

test("server-renders the no-lookahead backtest agent", async () => {
  const response = await render("/agent");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>成功率评测 Agent \| 分时罗盘<\/title>/i);
  assert.match(html, /同模型 · 逐分钟 · 无未来数据/);
  assert.match(html, /不连接账户，不执行交易/);
  assert.match(html, /运行逐分钟Agent/);
  assert.match(html, /扣费后胜率/);
  assert.match(html, /先信号，下一条行情成交/);
  assert.match(html, /大盘波浪过滤/);
  assert.match(html, /indexLevel/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("server-renders the convertible-bond synchronization radar", async () => {
  const response = await render("/bond-radar");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>转债同步雷达｜向上联动 Top 10<\/title>/i);
  assert.match(html, /捕捉波动，也看清谁在跟随/);
  assert.match(html, /向上联动 Top 10/);
  assert.match(html, /分钟同步率/);
  assert.match(html, /当日 9:30 第一根有效1分钟K线收盘价/);
  assert.match(html, /先捕捉，再确认/);
  assert.match(html, /09:35.*后/s);
  assert.match(html, /5分钟仅用于候选预览/);
  assert.match(html, /读取最新快照/);
  assert.match(html, /纯模型入选/);
  assert.doesNotMatch(html, /人工先验|模型外补位/);
  assert.match(html, /只读 · 不连接证券账户/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});
