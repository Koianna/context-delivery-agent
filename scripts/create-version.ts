#!/usr/bin/env npx tsx
import * as fs from "node:fs";
import { PROJECT_ROOT } from "./lib/config.js";
import {
  incrementPatch,
  parseFrontmatter,
  renderFrontmatter,
  repoRefToPath,
  writeTextAtomic,
} from "./lib/repository.js";

export interface CreateVersionInput {
  targetRef: string;
  contentRef: string;
  expectedVersion: string;
  sourceRefs: string[];
  confirmedAt: string;
  action?: "ARCHIVE";
  root?: string;
}

export interface CreateVersionResult {
  status: "CREATED" | "UNCHANGED";
  target_ref: string;
  previous_version: string;
  version: string;
}

export function createVersion(input: CreateVersionInput): CreateVersionResult {
  const root = input.root ?? PROJECT_ROOT;
  const targetPath = repoRefToPath(input.targetRef, root);
  const candidatePath = repoRefToPath(input.contentRef, root);
  if (!fs.existsSync(candidatePath)) throw new Error(`候选内容不存在: ${input.contentRef}`);

  if (!fs.existsSync(targetPath)) {
    if (input.expectedVersion !== "0.0.0") {
      throw new Error(`新建稳定 Context 必须使用基线版本 0.0.0: ${input.targetRef}`);
    }
    const candidate = parseFrontmatter(fs.readFileSync(candidatePath, "utf-8"));
    const id = candidate.metadata.id;
    if (typeof id !== "string") throw new Error(`候选内容缺少 id: ${input.contentRef}`);
    const version = typeof candidate.metadata.version === "string" ? candidate.metadata.version : "0.1.0";
    writeTextAtomic(targetPath, renderFrontmatter({
      ...candidate.metadata,
      id,
      version,
      status: "active",
      source_refs: input.sourceRefs,
      confirmed_by: "user",
      confirmed_at: input.confirmedAt,
    }, candidate.body));
    return { status: "CREATED", target_ref: input.targetRef, previous_version: "0.0.0", version };
  }

  const current = parseFrontmatter(fs.readFileSync(targetPath, "utf-8"));
  const candidate = parseFrontmatter(fs.readFileSync(candidatePath, "utf-8"));
  const currentVersion = current.metadata.version;
  if (typeof currentVersion !== "string") throw new Error(`目标缺少 version: ${input.targetRef}`);
  if (input.action === "ARCHIVE") {
    if (current.metadata.status === "archived") {
      return { status: "UNCHANGED", target_ref: input.targetRef, previous_version: currentVersion, version: currentVersion };
    }
    if (currentVersion !== input.expectedVersion) {
      throw new Error(`基线版本冲突: 期望 ${input.expectedVersion}, 当前 ${currentVersion}`);
    }
    writeTextAtomic(targetPath, renderFrontmatter({
      ...current.metadata,
      version: incrementPatch(currentVersion),
      status: "archived",
      archived_by: "user",
      archived_at: input.confirmedAt,
    }, current.body));
    return { status: "CREATED", target_ref: input.targetRef, previous_version: currentVersion, version: incrementPatch(currentVersion) };
  }
  if (current.body.trim() === candidate.body.trim()) {
    return { status: "UNCHANGED", target_ref: input.targetRef, previous_version: currentVersion, version: currentVersion };
  }
  if (currentVersion !== input.expectedVersion) {
    throw new Error(`基线版本冲突: 期望 ${input.expectedVersion}, 当前 ${currentVersion}`);
  }

  const id = current.metadata.id;
  if (typeof id !== "string") throw new Error(`目标缺少 id: ${input.targetRef}`);
  const existingSources = Array.isArray(current.metadata.source_refs) ? current.metadata.source_refs : [];
  const nextVersion = incrementPatch(currentVersion);
  const metadata: Record<string, string | string[] | null> = {
    ...current.metadata,
    id,
    version: nextVersion,
    status: "active",
    source_refs: [...new Set([...existingSources, ...input.sourceRefs])],
    confirmed_by: "user",
    confirmed_at: input.confirmedAt,
    supersedes: `${id}@${currentVersion}`,
  };
  writeTextAtomic(targetPath, renderFrontmatter(metadata, candidate.body));
  return { status: "CREATED", target_ref: input.targetRef, previous_version: currentVersion, version: nextVersion };
}

function main() {
  const args = process.argv.slice(2);
  const targetRef = argVal(args, "--target");
  const contentRef = argVal(args, "--content-ref");
  const expectedVersion = argVal(args, "--expected-version");
  const confirmedAt = argVal(args, "--confirmed-at") ?? new Date().toISOString();
  const sourceRefsRaw = argVal(args, "--source-refs") ?? "[]";
  if (!targetRef || !contentRef || !expectedVersion) {
    console.error("用法: create-version.ts --target <repo-ref> --content-ref <repo-ref> --expected-version <semver> --source-refs <json-array>");
    process.exit(1);
  }
  const sourceRefs = JSON.parse(sourceRefsRaw) as string[];
  console.log(JSON.stringify(createVersion({ targetRef, contentRef, expectedVersion, sourceRefs, confirmedAt }), null, 2));
}

function argVal(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

if (require.main === module) main();
