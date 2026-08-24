#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const bridgeUrl = "http://127.0.0.1:8765/health";
const bridgeScript = fileURLToPath(new URL("./realtime_quote_bridge.mjs", import.meta.url));
let bridgeProcess = null;

async function bridgeHealthy() {
  try {
    const response = await fetch(bridgeUrl, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

if (!(await bridgeHealthy())) {
  bridgeProcess = spawn(process.execPath, [bridgeScript], { stdio: "inherit" });
  for (let attempt = 0; attempt < 30 && !(await bridgeHealthy()); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!(await bridgeHealthy())) {
    bridgeProcess.kill();
    throw new Error("行情桥启动失败，请确认 8765 端口未被其他程序占用");
  }
}

const packageRunner = process.env.npm_execpath;
const webProcess = packageRunner
  ? spawn(process.execPath, [packageRunner, "run", "dev", "--hostname=localhost", "--port=4173"], { stdio: "inherit" })
  : spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev", "--", "--hostname=localhost", "--port=4173"], { stdio: "inherit" });

function stop(exitCode = 0) {
  if (bridgeProcess && !bridgeProcess.killed) bridgeProcess.kill();
  if (!webProcess.killed) webProcess.kill();
  process.exit(exitCode);
}

webProcess.on("exit", (code) => stop(code || 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
