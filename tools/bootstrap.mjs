#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const windows = process.platform === "win32";
const corepack = windows ? "corepack.cmd" : "corepack";
const npx = windows ? "npx.cmd" : "npx";
const corepackCheck = spawnSync(corepack, ["pnpm", "--version"], { stdio: "ignore" });
const command = corepackCheck.status === 0 ? corepack : npx;
const prefix = corepackCheck.status === 0 ? ["pnpm"] : ["--yes", "pnpm@11.9.0"];

function run(args) {
  const result = spawnSync(command, [...prefix, ...args], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

if (!existsSync(new URL("../node_modules", import.meta.url))) {
  console.log("首次运行，正在安装网页依赖……");
  run(["install", "--frozen-lockfile"]);
}
run(["run", "local"]);
