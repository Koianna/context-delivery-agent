#!/usr/bin/env npx tsx
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "./lib/config.js";
import type { PrdReviewOutput, PrdThinkingOutput, PrdWriteOutput } from "./lib/prd-types.js";
import { parseFrontmatter, pathToRepoRef, readJson, repoRefToPath } from "./lib/repository.js";

export function validatePrdThinking(output: PrdThinkingOutput, root = PROJECT_ROOT): string[] {
  const errors: string[] = [];
  if ((output as unknown as Record<string, unknown>).prd_artifact) errors.push("prd-thinking 不得输出 PRD artifact");
  if (output.writable_assessment.priority_questions.length > 3) errors.push("优先问题超过 3 个");
  const pendingBlocking = output.decision_ledger.filter((item) => item.is_blocking && item.status !== "CONFIRMED");
  if (pendingBlocking.length && output.writable_assessment.status === "READY") {
    errors.push("存在未确认阻塞决策时不能标记 READY");
  }
  const ids = new Set<string>();
  for (const decision of output.decision_ledger) {
    if (ids.has(decision.decision_id)) errors.push(`重复 decision_id: ${decision.decision_id}`);
    ids.add(decision.decision_id);
    if (decision.status === "CONFIRMED" && !decision.human_decision) {
      errors.push(`${decision.decision_id} 标记 CONFIRMED 但没有 human_decision`);
    }
  }
  // 校验资料状态分层表（material_classification）
  const classification = output.background_card.material_classification;
  if (!classification || !Array.isArray(classification)) {
    errors.push("background_card.material_classification 缺失或非数组");
  } else {
    const validCategories = new Set(["stable_context", "historical_prd", "material_analysis", "user_material", "decision_ledger", "external_standard"]);
    const validAdoptions = new Set(["default_adopt", "reference_only", "needs_confirmation", "verify_version"]);
    const allSourceRefs = new Set([...output.background_card.materials_read, ...output.background_card.source_refs]);
    for (const item of classification) {
      if (!validCategories.has(item.category)) {
        errors.push(`material_classification 中 category 非法: ${item.category}`);
      }
      if (!validAdoptions.has(item.adoption)) {
        errors.push(`material_classification 中 adoption 非法: ${item.adoption}`);
      }
      if (!allSourceRefs.has(item.source_ref)) {
        errors.push(`material_classification 引用了未在 materials_read/source_refs 中的 ref: ${item.source_ref}`);
      }
      // 反自洽：default_adopt 不得落在 user_material/historical_prd
      if (item.adoption === "default_adopt" && (item.category === "user_material" || item.category === "historical_prd")) {
        errors.push(`material_classification 反自洽: ${item.source_ref} 为 ${item.category} 但标记为 default_adopt（草稿不能当已上线事实）`);
      }
    }
  }
  for (const ref of [...output.background_card.materials_read, ...output.background_card.source_refs]) {
    validateRepoRef(ref, errors, root);
  }
  return errors;
}

export function validatePrdWrite(
  output: PrdWriteOutput,
  confirmedDecisionIds: string[],
  root = PROJECT_ROOT
): string[] {
  const errors: string[] = [];
  const artifact = output.prd_artifact;
  if (!/^\d+\.\d+\.\d+$/.test(artifact.version)) errors.push("PRD version 必须是语义版本");
  if (output.coverage.missing_sections.length) errors.push("PRD 存在缺失必需章节");
  const covered = new Set(output.coverage.covered_sections);
  for (const section of output.coverage.required_sections) {
    if (!covered.has(section)) errors.push(`必需章节未覆盖: ${section}`);
  }
  if (artifact.decision_refs.some((id) => !confirmedDecisionIds.includes(id))) {
    errors.push("PRD 引用了未确认决策");
  }
  if (output.unsupported_claims.length) errors.push("PRD 存在 unsupported_claims");
  for (const ref of [...artifact.source_refs, artifact.content_ref]) validateRepoRef(ref, errors, root);
  if (!artifact.markdown_ref.startsWith("repo://context-workspace/workspace/prd/")) errors.push("PRD markdown_ref 路径非法");

  try {
    const body = parseFrontmatter(fs.readFileSync(repoRefToPath(artifact.content_ref, root), "utf-8")).body;
    if (artifact.phase === "CORE" && /## (8|9|10)\.|验收标准|角色与权限/.test(body)) {
      errors.push("CORE 候选提前展开 DETAILS 内容");
    }
    if (artifact.phase === "DETAILS" || artifact.phase === "REVISION") {
      for (const heading of ["功能规则", "角色与权限", "边界与异常", "验收标准"]) {
        if (!body.includes(heading)) errors.push(`${artifact.phase} 缺少章节: ${heading}`);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

export function validatePrdReview(
  output: PrdReviewOutput,
  prdRef: string,
  root = PROJECT_ROOT
): string[] {
  const errors: string[] = [];
  const prd = parseFrontmatter(fs.readFileSync(repoRefToPath(prdRef, root), "utf-8"));
  const hash = crypto.createHash("sha256").update(prd.body).digest("hex");
  if (output.prd_sha256 !== hash) errors.push("审核记录的 PRD hash 与正文不一致");
  if (output.reviewed_prd_version !== prd.metadata.version) errors.push("审核版本与 PRD frontmatter 不一致");
  const counts = {
    P0: output.issues.filter((item) => item.severity === "P0").length,
    P1: output.issues.filter((item) => item.severity === "P1").length,
    P2: output.issues.filter((item) => item.severity === "P2").length,
  };
  if (counts.P0 !== output.summary.p0_count || counts.P1 !== output.summary.p1_count || counts.P2 !== output.summary.p2_count) {
    errors.push("审核问题计数与 summary 不一致");
  }
  for (const issue of output.issues) {
    if (!issue.location || !issue.description || !issue.impact || !issue.recommended_fix) {
      errors.push(`${issue.issue_id} 缺少定位、描述、影响或建议`);
    }
  }
  if ((counts.P0 > 0 || counts.P1 > 0) && ["PASS", "PASS_WITH_NOTES"].includes(output.summary.recommendation)) {
    errors.push("存在 P0/P1 时不能建议交付");
  }
  return errors;
}

export function validatePrdReviewDecisionLedger(
  decisionRefs: string[],
  decisionLedgerPath: string,
  root = PROJECT_ROOT
): string[] {
  const errors: string[] = [];
  try {
    if (!decisionRefs.length) errors.push("PRD 缺少决策引用，无法核对正式决策账本");

    if (!fs.existsSync(decisionLedgerPath)) {
      errors.push(`正式决策账本不存在: ${pathToRepoRef(decisionLedgerPath, root)}`);
      return errors;
    }
    const ledger = readJson<{ decisions?: Array<{ decision_id?: string; status?: string }> }>(decisionLedgerPath);
    const statusByDecision = new Map<string, string>();
    for (const decision of ledger.decisions ?? []) {
      if (typeof decision.decision_id !== "string" || !decision.decision_id) {
        errors.push("正式决策账本存在缺失 decision_id 的记录");
        continue;
      }
      if (statusByDecision.has(decision.decision_id)) {
        errors.push(`正式决策账本存在重复 decision_id: ${decision.decision_id}`);
        continue;
      }
      statusByDecision.set(decision.decision_id, typeof decision.status === "string" ? decision.status : "");
    }
    for (const decisionId of decisionRefs) {
      const status = statusByDecision.get(decisionId);
      if (!status) {
        errors.push(`PRD 引用的决策未出现在正式决策账本: ${decisionId}`);
      } else if (status !== "CONFIRMED") {
        errors.push(`PRD 引用的决策尚未确认: ${decisionId}`);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

function validateRepoRef(ref: string, errors: string[], root: string) {
  try {
    const file = repoRefToPath(ref, root);
    if (!fs.existsSync(file)) errors.push(`引用不存在: ${ref}`);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}

function main() {
  const args = process.argv.slice(2);
  const skill = argVal(args, "--skill");
  const outputArg = argVal(args, "--output");
  if (!skill || !outputArg) {
    console.error("用法: validate-prd-output.ts --skill prd-thinking|prd-write|prd-review --output <json> [--decision-ledger <json>] [--prd-ref <repo-ref>]");
    process.exit(1);
  }
  const outputPath = path.isAbsolute(outputArg) ? outputArg : path.join(PROJECT_ROOT, outputArg);
  let errors: string[] = [];
  if (skill === "prd-thinking") {
    errors = validatePrdThinking(readJson<PrdThinkingOutput>(outputPath));
  } else if (skill === "prd-write") {
    const ledgerArg = argVal(args, "--decision-ledger");
    if (!ledgerArg) throw new Error("prd-write 校验需要 --decision-ledger");
    const ledgerPath = path.isAbsolute(ledgerArg) ? ledgerArg : path.join(PROJECT_ROOT, ledgerArg);
    const ledger = readJson<{ decisions: Array<{ decision_id: string; status: string }> }>(ledgerPath);
    const ids = ledger.decisions.filter((item) => item.status === "CONFIRMED").map((item) => item.decision_id);
    errors = validatePrdWrite(readJson<PrdWriteOutput>(outputPath), ids);
  } else if (skill === "prd-review") {
    const prdRef = argVal(args, "--prd-ref");
    if (!prdRef) throw new Error("prd-review 校验需要 --prd-ref");
    errors = validatePrdReview(readJson<PrdReviewOutput>(outputPath), prdRef);
    const ledgerArg = argVal(args, "--decision-ledger");
    if (ledgerArg) {
      const ledgerPath = path.isAbsolute(ledgerArg) ? ledgerArg : path.join(PROJECT_ROOT, ledgerArg);
      const prd = parseFrontmatter(fs.readFileSync(repoRefToPath(prdRef, PROJECT_ROOT), "utf-8"));
      const decisionRefs = Array.isArray(prd.metadata.decision_refs)
        ? prd.metadata.decision_refs.filter((value): value is string => typeof value === "string")
        : [];
      errors = errors.concat(validatePrdReviewDecisionLedger(decisionRefs, ledgerPath, PROJECT_ROOT));
    }
  } else {
    throw new Error(`未知 Skill: ${skill}`);
  }
  console.log(JSON.stringify({ status: errors.length ? "FAIL" : "PASS", errors }, null, 2));
  if (errors.length) process.exit(1);
}

function argVal(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

if (require.main === module) main();
