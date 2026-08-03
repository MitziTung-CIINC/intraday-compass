import assert from "node:assert/strict";
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
  assert.match(html, /腾讯财经公开行情（本机只读桥）/);
  assert.match(html, /管理持仓/);
  assert.match(html, /示例：贵州茅台/);
  assert.match(html, /真实持仓与做T账本/);
  assert.match(html, /记录真实买入/);
  assert.match(html, /降低成本成功率/);
  assert.match(html, /交易日历依据/);
  assert.match(html, /MACD柱 \(12,26,9\)/);
  assert.match(html, /视频规则模式/);
  assert.match(html, /消息面风险锁定/);
  assert.match(html, /单次上限/);
  assert.match(html, /大盘波浪 · 个股空仓指引/);
  assert.match(html, /成功率Agent/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
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
