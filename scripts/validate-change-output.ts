#!/usr/bin/env npx tsx
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "./lib/config.js";
import { sha256Buffer, validateSnapshotIntegrity } from "./lib/change-snapshot.js";
import type {
  ChangeAnalysisOutput, ChangeRequestInput, ChangeType, ReplanOutput, ReplanReturnState,
} from "./lib/change-types.js";
import { parseFrontmatter, readJson, repoRefToPath } from "./lib/repository.js";
import { contextIndexPath } from "./lib/project-paths.js";

const RETURN_BY_TYPE: Partial<Record<ChangeType, ReplanReturnState>> = {
  SOURCE_CHANGE: "CONTEXT_ANALYZING",
  FACT_CHANGE: "CONTEXT_ANALYZING",
  GOAL_CHANGE: "PRD_THINKING",
  SCOPE_CHANGE: "PRD_THINKING",
  DECISION_CHANGE: "PRD_THINKING",
  CORE_FLOW_CHANGE: "PRD_DRAFTING_CORE",
  DETAIL_RULE_CHANGE: "PRD_DRAFTING_DETAILS",
};

export function validateChangeInput(input: ChangeRequestInput, root = PROJECT_ROOT): string[] {
  const errors: string[] = [];
  if (!input.change_request.change_id || !input.change_request.change_text) errors.push("变更请求缺少 change_id 或 change_text");
  if (input.request_meta.current_state !== "CHANGE_ANALYZING") errors.push("变更输入要求 current_state=CHANGE_ANALYZING");
  if (!input.artifact_refs.length) errors.push("变更输入缺少 artifact_refs");
  if (new Set(input.artifact_refs).size !== input.artifact_refs.length) errors.push("artifact_refs 存在重复项");
  for (const ref of [...input.artifact_refs, ...input.change_request.source_refs]) validateRef(ref, errors, root);
  if (!/^\d+\.\d+\.\d+$/.test(input.task_snapshot.plan_version)) errors.push("plan_version 必须是语义版本");
  try {
    const prdRef = input.artifact_refs.find((ref) => ref.startsWith("repo://context-workspace/workspace/prd/"));
    if (!prdRef) {
      errors.push("变更输入缺少 PRD 基线引用");
    } else {
      const prd = parseFrontmatter(fs.readFileSync(repoRefToPath(prdRef, root), "utf-8"));
      if (prd.metadata.version !== input.task_snapshot.prd_version) errors.push("输入 PRD 版本与实际文件不一致");
    }
    const ledgerRef = input.artifact_refs.find((ref) =>
      ref.includes("/decisions/") && ref.endsWith("decision-ledger.json")
    );
    if (!ledgerRef) {
      errors.push("变更输入缺少决策账本引用");
    } else {
      const ledger = readJson<{ version: string; decisions: Array<{ decision_id: string; status: string }> }>(repoRefToPath(ledgerRef, root));
      if (ledger.version !== input.task_snapshot.decision_ledger_version) errors.push("输入决策版本与实际文件不一致");
      const confirmedIds = new Set(ledger.decisions.filter((item) => item.status === "CONFIRMED").map((item) => item.decision_id));
      if (input.confirmed_decision_refs.some((id) => !confirmedIds.has(id))) errors.push("输入引用了未确认或不存在的决策");
    }
    const indexRef = contextIndexPath(input.request_meta.project_id, root);
    const hasIndexArtifact = input.artifact_refs.some((ref) => ref === `repo://context-workspace/context/${input.request_meta.project_id}/INDEX.md`);
    if (hasIndexArtifact) {
      const index = parseFrontmatter(fs.readFileSync(indexRef, "utf-8"));
      if (index.metadata.version !== input.task_snapshot.context_version) errors.push("输入 Context 版本与索引不一致");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

export function validateChangeAnalysis(
  input: ChangeRequestInput,
  output: ChangeAnalysisOutput,
  root = PROJECT_ROOT
): string[] {
  const errors = validateChangeInput(input, root);
  if (output.mode !== "ANALYZE") errors.push("change-impact 分析输出 mode 必须是 ANALYZE");
  if (output.change_id !== input.change_request.change_id) errors.push("分析输出 change_id 与输入不一致");
  if (output.change_classification.confidence < 0 || output.change_classification.confidence > 1) errors.push("confidence 必须在 0 到 1 之间");
  const expectedReturn = RETURN_BY_TYPE[output.change_classification.change_type] ?? null;
  if (output.recommended_return_state !== expectedReturn) errors.push(`变更类型应返回 ${expectedReturn ?? "null"}`);
  if (["UNKNOWN", "WORDING_ONLY"].includes(output.change_classification.change_type) && output.change_classification.is_material_change) {
    errors.push("UNKNOWN 或 WORDING_ONLY 不能标记为实质重规划");
  }
  if (output.change_classification.is_material_change && output.affected_items.length === 0) errors.push("实质变化必须列出受影响内容");
  if (output.unaffected_items.length === 0) errors.push("必须明确至少一项不受影响内容");
  const allowedRefs = new Set(input.artifact_refs);
  const ids = new Set<string>();
  for (const item of [...output.affected_items, ...output.unaffected_items]) {
    if (ids.has(item.item_id)) errors.push(`重复 impact item_id: ${item.item_id}`);
    ids.add(item.item_id);
    if (!allowedRefs.has(item.artifact_ref)) errors.push(`影响项引用不在输入快照范围: ${item.artifact_ref}`);
    if (!item.locations.length || !item.reason) errors.push(`${item.item_id} 缺少位置或原因`);
  }
  if (output.change_summary.source_refs.some((ref) => !input.change_request.source_refs.includes(ref))) {
    errors.push("变更摘要引用了输入中不存在的来源");
  }
  errors.push(...validateSnapshotIntegrity(output.snapshot_ref, root));
  return errors;
}

export function validateReplan(
  analysis: ChangeAnalysisOutput,
  output: ReplanOutput,
  root = PROJECT_ROOT
): string[] {
  const errors: string[] = [];
  if (output.mode !== "REPLAN") errors.push("重规划输出 mode 必须是 REPLAN");
  if (output.change_id !== analysis.change_id) errors.push("重规划 change_id 与影响报告不一致");
  if (output.snapshot_ref !== analysis.snapshot_ref) errors.push("重规划未沿用影响分析快照");
  if (output.plan.status !== "DRAFT") errors.push("CP-R01 前计划状态必须是 DRAFT");
  if (!/^\d+\.\d+\.\d+$/.test(output.plan.version) || !/^\d+\.\d+\.\d+$/.test(output.plan.previous_version)) {
    errors.push("计划版本必须使用语义版本");
  }
  if (output.plan.version === output.plan.previous_version) errors.push("新计划版本不能等于前序版本");
  if (output.plan.recommended_return_state !== analysis.recommended_return_state) errors.push("计划返回节点与影响分析不一致");
  if (!output.plan.steps.length || output.plan.steps[0]?.state !== output.plan.recommended_return_state) {
    errors.push("计划第一步必须从推荐返回节点开始");
  }
  const stepIds = new Set(output.plan.steps.map((step) => step.step_id));
  if (stepIds.size !== output.plan.steps.length) errors.push("计划 step_id 重复");
  for (const step of output.plan.steps) {
    if (step.depends_on.some((id) => !stepIds.has(id))) errors.push(`${step.step_id} 引用了不存在的依赖步骤`);
    for (const ref of step.input_refs) validateRef(ref, errors, root);
  }
  if (!output.plan.required_confirmations.includes("CP-R01")) errors.push("重规划计划缺少 CP-R01");
  const preservedRefs = new Set([
    ...output.plan.preserved_artifacts,
    ...output.plan.preserved_items.map((item) => item.artifact_ref),
  ]);
  for (const item of analysis.unaffected_items) {
    if (!preservedRefs.has(item.artifact_ref)) errors.push(`未保留不受影响产物: ${item.artifact_ref}`);
  }
  const affectedRefs = new Set(analysis.affected_items.map((item) => item.artifact_ref));
  if (output.plan.deprecated_artifacts.some((ref) => !affectedRefs.has(ref))) errors.push("待替代产物不在影响范围内");
  try {
    const analysisPath = repoRefToPath(output.analysis_ref, root);
    const hash = sha256Buffer(fs.readFileSync(analysisPath));
    if (hash !== output.analysis_sha256) errors.push("重规划引用的影响报告 hash 不一致");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  errors.push(...validateSnapshotIntegrity(output.snapshot_ref, root));
  return errors;
}

function validateRef(ref: string, errors: string[], root: string) {
  try {
    if (!fs.existsSync(repoRefToPath(ref, root))) errors.push(`引用不存在: ${ref}`);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}

function main() {
  const args = process.argv.slice(2);
  const mode = argVal(args, "--mode");
  const outputArg = argVal(args, "--output");
  if (!mode || !outputArg) {
    console.error("用法: validate-change-output.ts --mode ANALYZE|REPLAN --output <json> [--input <json>|--analysis <json>]");
    process.exit(1);
  }
  const outputPath = resolveArg(outputArg);
  let errors: string[];
  if (mode === "ANALYZE") {
    const inputArg = argVal(args, "--input");
    if (!inputArg) throw new Error("ANALYZE 校验需要 --input");
    errors = validateChangeAnalysis(readJson<ChangeRequestInput>(resolveArg(inputArg)), readJson<ChangeAnalysisOutput>(outputPath));
  } else if (mode === "REPLAN") {
    const analysisArg = argVal(args, "--analysis");
    if (!analysisArg) throw new Error("REPLAN 校验需要 --analysis");
    errors = validateReplan(readJson<ChangeAnalysisOutput>(resolveArg(analysisArg)), readJson<ReplanOutput>(outputPath));
  } else {
    throw new Error(`未知 mode: ${mode}`);
  }
  console.log(JSON.stringify({ status: errors.length ? "FAIL" : "PASS", errors }, null, 2));
  if (errors.length) process.exit(1);
}

function resolveArg(value: string): string {
  return path.isAbsolute(value) ? value : path.join(PROJECT_ROOT, value);
}

function argVal(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

if (require.main === module) main();
