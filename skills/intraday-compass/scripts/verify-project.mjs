#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requiredFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "start-local.cmd",
  "start-local.sh",
  "app/MarketCopilot.tsx",
  "tools/realtime_quote_bridge.mjs",
  "tools/start-local.mjs",
];

function isProjectRoot(candidate) {
  return requiredFiles.slice(0, 3).every((file) =>
    fs.existsSync(path.join(candidate, file)),
  );
}

function findProjectRoot(start) {
  let current = path.resolve(start);
  while (true) {
    if (isProjectRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const requestedRoot = process.argv[2] ? path.resolve(process.argv[2]) : null;
const projectRoot = requestedRoot
  || findProjectRoot(process.cwd())
  || findProjectRoot(scriptDirectory);

if (!projectRoot || !isProjectRoot(projectRoot)) {
  console.error(JSON.stringify({
    ok: false,
    error: "Intraday Compass project root not found",
    hint: "Pass the cloned repository path as the first argument.",
  }, null, 2));
  process.exit(1);
}

const missingFiles = requiredFiles.filter((file) =>
  !fs.existsSync(path.join(projectRoot, file)),
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
);
const nodeMajor = Number(process.versions.node.split(".")[0]);
const packageManagerValid = packageJson.packageManager === "pnpm@11.9.0";
const scriptsValid = Boolean(packageJson.scripts?.local && packageJson.scripts?.test);
const ok = nodeMajor >= 22
  && missingFiles.length === 0
  && packageManagerValid
  && scriptsValid;

console.log(JSON.stringify({
  ok,
  projectRoot,
  nodeVersion: process.versions.node,
  packageManager: packageJson.packageManager || null,
  missingFiles,
  checks: {
    node22OrNewer: nodeMajor >= 22,
    packageManagerPinned: packageManagerValid,
    requiredScriptsPresent: scriptsValid,
  },
  nextCommands: ok
    ? ["corepack pnpm install --frozen-lockfile", "corepack pnpm run local"]
    : [],
}, null, 2));

process.exit(ok ? 0 : 1);
