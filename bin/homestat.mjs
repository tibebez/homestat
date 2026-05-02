#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.resolve(__dirname, "../dist/cli.js");

if (!existsSync(cliPath)) {
  console.error("homestat build artifacts are missing. Run: bun run build");
  process.exit(1);
}

const child = spawn("bun", [cliPath, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

child.on("error", (error) => {
  if ((error && "code" in error && error.code === "ENOENT")) {
    console.error("homestat requires Bun runtime. Install Bun: https://bun.sh");
    process.exit(1);
  }

  console.error("Failed to start homestat with Bun:", error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
