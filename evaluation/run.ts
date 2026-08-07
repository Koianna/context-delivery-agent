#!/usr/bin/env npx tsx
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { PROJECT_ROOT } from "../scripts/lib/config.js";

const evaluations = [
  "run-context-branch.ts",
  "run-context-section-move.ts",
  "run-prd-branch.ts",
  "run-change-branch.ts",
  "run-confirmation-parser.ts",
  "run-material-reprocess.ts",
  "run-workspace-provider.ts",
  "run-openai-provider.ts",
  "run-agent-interaction.ts",
  "run-gateway.ts",
  "run-mcp.ts",
];

for (const evaluation of evaluations) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(PROJECT_ROOT, "evaluation", evaluation)],
    { cwd: PROJECT_ROOT, encoding: "utf-8" },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    console.error(`回归失败: ${evaluation}`);
    process.exit(result.status ?? 1);
  }
}

console.log(JSON.stringify({ status: "PASSED", evaluation_count: evaluations.length }, null, 2));
