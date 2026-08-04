#!/usr/bin/env npx tsx
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "./lib/config.js";
import { parseFrontmatter } from "./lib/repository.js";

const skillNames = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["material-ingest", "context-maintain", "prd-thinking", "prd-write", "prd-review", "change-impact"];
const errors: string[] = [];

for (const skillName of skillNames) {
  const directory = path.join(PROJECT_ROOT, "skills", skillName);
  const skillPath = path.join(directory, "SKILL.md");
  if (!fs.existsSync(skillPath)) {
    errors.push(`${skillName}: 缺少 SKILL.md`);
    continue;
  }
  const document = parseFrontmatter(fs.readFileSync(skillPath, "utf-8"));
  const keys = Object.keys(document.metadata);
  if (document.metadata.name !== skillName) errors.push(`${skillName}: frontmatter name 与目录名不一致`);
  if (typeof document.metadata.description !== "string" || document.metadata.description.length < 20) {
    errors.push(`${skillName}: description 缺失或过短`);
  }
  const extraKeys = keys.filter((key) => !["name", "description"].includes(key));
  if (extraKeys.length) errors.push(`${skillName}: frontmatter 包含非必要字段 ${extraKeys.join(", ")}`);
  for (const resource of ["prompt.md", "schema.json", "references", "examples", "tests"]) {
    if (!fs.existsSync(path.join(directory, resource))) errors.push(`${skillName}: 缺少 ${resource}`);
  }
  try {
    JSON.parse(fs.readFileSync(path.join(directory, "schema.json"), "utf-8"));
  } catch {
    errors.push(`${skillName}: schema.json 不是有效 JSON`);
  }
}

console.log(JSON.stringify({ status: errors.length ? "FAIL" : "PASS", skills: skillNames, errors }, null, 2));
if (errors.length) process.exit(1);
