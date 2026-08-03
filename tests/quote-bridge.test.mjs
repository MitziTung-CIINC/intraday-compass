import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("starts the self-contained local quote bridge", async (context) => {
  const port = 18000 + (process.pid % 1000);
  const child = spawn(process.execPath, ["tools/realtime_quote_bridge.mjs"], {
    env: { ...process.env, T0_QUOTE_BRIDGE_PORT: String(port) },
    stdio: "ignore",
  });
  context.after(() => child.kill());

  let response;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  assert.ok(response?.ok, "quote bridge did not become healthy");
  const payload = await response.json();
  assert.equal(payload.provider, "tencent-public-quote");
  assert.equal(payload.recommendedPollMs, 1000);
});
