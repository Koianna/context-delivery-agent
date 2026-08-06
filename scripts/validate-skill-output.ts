#!/usr/bin/env npx tsx
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "./lib/config.js";
import type {
  ContextAnalysisOutput,
  InformationItem,
  MaterialIngestInput,
  MaterialIngestOutput,
} from "./lib/context-types.js";
import { readJson, repoRefToPath } from "./lib/repository.js";

const INFORMATION_TYPES = new Set(["USER_FEEDBACK", "OBSERVATION", "FACT", "DATA", "OPINION", "PROPOSAL", "CONFIRMED_DECISION", "OPEN_QUESTION", "DEPRECATED_CONTENT"]);
const MATURITIES = new Set(["RAW", "UNCONFIRMED", "CONFIRMED", "SUPERSEDED", "ARCHIVED"]);
const STABLE_ACTIONS = new Set(["PROMOTE_TO_CONTEXT", "UPDATE_CONTEXT", "MARK_SUPERSEDED", "ARCHIVE"]);
const ACTIONS = new Set(["WRITE_DRAFT", "WRITE_WORKSPACE", ...STABLE_ACTIONS, "UPDATE_INDEX", "FIX_REFERENCE", "NO_ACTION"]);
const STABLE_CONTEXT_REF = /^repo:\/\/context-workspace\/context\/[a-z0-9][a-z0-9_-]{0,63}\/(?:product|users|business-rules|glossary)\/.+$/;

export function validateMaterialOutput(
  input: MaterialIngestInput,
  output: MaterialIngestOutput,
  root = PROJECT_ROOT
): string[] {
  const errors: string[] = [];
  const sources = new Map(input.materials.map((material) => [material.source_id, material]));
  const records = new Map(output.material_records.map((record) => [record.source_id, record]));

  for (const sourceId of input.analysis_scope.included_source_ids) {
    if (!records.has(sourceId)) errors.push(`缺少材料处理记录: ${sourceId}`);
  }
  for (const material of input.materials) {
    try {
      const sourcePath = repoRefToPath(material.content_ref, root);
      if (!fs.existsSync(sourcePath)) errors.push(`来源文件不存在: ${material.content_ref}`);
    } catch (error) {
      errors.push(String(error));
    }
    const expectedMissing = !material.source_owner ? "source_owner" : null;
    if (expectedMissing && !records.get(material.source_id)?.missing_metadata.includes(expectedMissing)) {
      errors.push(`${material.source_id} 未标记缺失的 ${expectedMissing}`);
    }
  }

  const itemIds = new Set<string>();
  for (const item of output.information_items) {
    validateInformationItem(item, sources, itemIds, errors, root);
  }

  const summary = output.processing_summary;
  if (summary.material_count !== input.materials.length) errors.push("material_count 与输入不一致");
  if (summary.information_item_count !== output.information_items.length) errors.push("information_item_count 与实际数组长度不一致");
  if (summary.failed_count !== output.failed_materials.length) errors.push("failed_count 与 failed_materials 不一致");
  if (summary.processed_count + summary.failed_count !== summary.material_count) errors.push("processed_count + failed_count 不等于 material_count");
  return errors;
}

function validateInformationItem(
  item: InformationItem,
  sources: Map<string, MaterialIngestInput["materials"][number]>,
  itemIds: Set<string>,
  errors: string[],
  root: string
) {
  if (itemIds.has(item.item_id)) errors.push(`重复 item_id: ${item.item_id}`);
  itemIds.add(item.item_id);
  if (!INFORMATION_TYPES.has(item.information_type)) errors.push(`${item.item_id} information_type 非法`);
  if (!MATURITIES.has(item.maturity)) errors.push(`${item.item_id} maturity 非法`);
  if (item.confidence < 0 || item.confidence > 1) errors.push(`${item.item_id} confidence 超出范围`);
  if (item.source_refs.length === 0 || item.evidence.length === 0) errors.push(`${item.item_id} 缺少来源或证据`);

  for (const sourceId of item.source_refs) {
    const source = sources.get(sourceId);
    if (!source) {
      errors.push(`${item.item_id} 引用了未知来源 ${sourceId}`);
      continue;
    }
    if ((!source.source_owner || !source.source_time) && item.target_layer !== "DRAFTS") {
      errors.push(`${item.item_id} 来源元数据不完整，只能进入 DRAFTS`);
    }
  }
  for (const evidence of item.evidence) {
    const source = sources.get(evidence.source_id);
    if (!source || !item.source_refs.includes(evidence.source_id)) {
      errors.push(`${item.item_id} 证据来源未登记: ${evidence.source_id}`);
      continue;
    }
    const content = fs.readFileSync(repoRefToPath(source.content_ref, root), "utf-8");
    if (!content.includes(evidence.quote)) errors.push(`${item.item_id} 的 quote 未出现在来源中`);
  }
  if (item.target_layer === "CONTEXT" && !item.requires_confirmation) {
    errors.push(`${item.item_id} 建议进入稳定 Context 但未要求确认`);
  }
}

export function validateContextAnalysis(
  materialOutput: MaterialIngestOutput,
  output: ContextAnalysisOutput,
  root = PROJECT_ROOT,
  projectId?: string
): string[] {
  const errors: string[] = [];
  if (output.action !== "ANALYZE") errors.push("context-maintain 分析输出 action 必须为 ANALYZE");
  const items = new Map(materialOutput.information_items.map((item) => [item.item_id, item]));
  const proposalIds = new Set<string>();
  for (const proposal of output.update_proposals) {
    if (proposalIds.has(proposal.proposal_id)) errors.push(`重复 proposal_id: ${proposal.proposal_id}`);
    proposalIds.add(proposal.proposal_id);
    if (!ACTIONS.has(proposal.action)) errors.push(`${proposal.proposal_id} action 非法`);
    const item = items.get(proposal.item_id);
    if (!item) errors.push(`${proposal.proposal_id} 引用了未知 item_id`);
    if (item && proposal.source_refs.some((source) => !item.source_refs.includes(source))) {
      errors.push(`${proposal.proposal_id} 的来源超出信息单元来源`);
    }
    if (STABLE_ACTIONS.has(proposal.action)) {
      if (!proposal.requires_confirmation) errors.push(`${proposal.proposal_id} 稳定写入未要求 CP-C01`);
      if (!item || !["CONFIRMED", "SUPERSEDED", "ARCHIVED"].includes(item.maturity)) {
        errors.push(`${proposal.proposal_id} 使用未确认信息修改稳定 Context`);
      }
      if (!proposal.target_ref || !STABLE_CONTEXT_REF.test(proposal.target_ref)) {
        errors.push(`${proposal.proposal_id} 稳定写入目标不在 context/<project_id>/`);
      }
      if (!proposal.base_version || !proposal.content_ref) {
        errors.push(`${proposal.proposal_id} 缺少 base_version 或 content_ref`);
      } else {
        try {
          if (!fs.existsSync(repoRefToPath(proposal.content_ref, root))) {
            errors.push(`${proposal.proposal_id} 候选内容不存在`);
          }
        } catch (error) {
          errors.push(String(error));
        }
      }
    }
  }
  for (const id of output.auto_actions) {
    const proposal = output.update_proposals.find((item) => item.proposal_id === id);
    if (!proposal) errors.push(`auto_actions 引用了未知 proposal: ${id}`);
    if (proposal && STABLE_ACTIONS.has(proposal.action)) errors.push(`稳定写入不能列入 auto_actions: ${id}`);
  }
  return errors;
}

function main() {
  const args = process.argv.slice(2);
  const skill = argVal(args, "--skill");
  const inputArg = argVal(args, "--input");
  const outputArg = argVal(args, "--output");
  const materialArg = argVal(args, "--material-output");
  if (!skill || !outputArg) {
    console.error("用法: validate-skill-output.ts --skill material-ingest|context-maintain --output <json> [--input <json>] [--material-output <json>]");
    process.exit(1);
  }
  const resolve = (value: string) => path.isAbsolute(value) ? value : path.join(PROJECT_ROOT, value);
  let errors: string[];
  if (skill === "material-ingest" && inputArg) {
    errors = validateMaterialOutput(
      readJson<MaterialIngestInput>(resolve(inputArg)),
      readJson<MaterialIngestOutput>(resolve(outputArg))
    );
  } else if (skill === "context-maintain" && materialArg) {
    errors = validateContextAnalysis(
      readJson<MaterialIngestOutput>(resolve(materialArg)),
      readJson<ContextAnalysisOutput>(resolve(outputArg))
    );
  } else {
    console.error("material-ingest 需要 --input；context-maintain 需要 --material-output");
    process.exit(1);
  }
  console.log(JSON.stringify({ status: errors.length === 0 ? "PASS" : "FAIL", errors }, null, 2));
  if (errors.length > 0) process.exit(1);
}

function argVal(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

if (require.main === module) main();
