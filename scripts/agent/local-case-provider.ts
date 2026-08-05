import * as fs from "node:fs";
import * as path from "node:path";
import { hashReplanForApproval } from "../lib/change-guards.js";
import { sha256Buffer } from "../lib/change-snapshot.js";
import type {
  ChangeAnalysisOutput,
  ChangeRequestInput,
  ReplanOutput,
} from "../lib/change-types.js";
import { PROJECT_ROOT } from "../lib/config.js";
import type { PrdWriteOutput } from "../lib/prd-types.js";
import { readJson, repoRefToPath, writeJsonAtomic } from "../lib/repository.js";
import type { TaskState } from "../lib/types.js";
import type {
  AgentProvider,
  ChangeAnalysisAssets,
  ChangeReplanAssets,
  PrdProviderAssets,
} from "./types.js";
import { writeStructuredMaterial } from "./structured-material.js";

export class LocalCaseProvider implements AgentProvider {
  readonly id = "local-case";
  readonly label = "本地可复现 Provider";
  private readonly caseRoot = path.join(PROJECT_ROOT, "case-data/help-center-search");

  getContextAssets(materialPath?: string) {
    if (materialPath) this.assertSupportedMaterialPath(materialPath);
    const input = readJson<import("../lib/context-types.js").MaterialIngestInput>(path.join(this.caseRoot, "material-ingest.input.json"));
    const output = readJson<import("../lib/context-types.js").MaterialIngestOutput>(path.join(this.caseRoot, "expected-outputs/material-ingest.output.json"));
    const structuredMaterialPath = path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs", "local-case-materials", "materials/structured-materials.md");
    writeStructuredMaterial(input, output, structuredMaterialPath, PROJECT_ROOT);
    return {
      inputPath: path.join(this.caseRoot, "material-ingest.input.json"),
      materialOutputPath: path.join(
        this.caseRoot,
        "expected-outputs/material-ingest.output.json"
      ),
      contextOutputPath: path.join(
        this.caseRoot,
        "expected-outputs/context-maintain.analysis.json"
      ),
      structuredMaterialPath,
    };
  }

  getContextReportRefs(taskId: string, structuredMaterialPath?: string) {
    const base = `repo://context-workspace/workspace/agent-runs/${safeSlug(taskId)}`;
    const name = structuredMaterialPath ? path.basename(structuredMaterialPath) : "structured-materials.md";
    return {
      materialReportRef: `${base}/reports/material-analysis.json`,
      contextReportRef: `${base}/reports/context-analysis.json`,
      structuredMaterialRef: `${base}/materials/${name}`,
      changeLogRef: `${base}/reports/context-change-log.json`,
    };
  }

  getPrdAssets(taskId: string): PrdProviderAssets {
    const slug = safeSlug(taskId);
    const outputDir = this.outputDir(slug);
    const prdRef = `repo://context-workspace/workspace/prd/help-center-search-${slug}.md`;
    const core = readJson<PrdWriteOutput>(path.join(
      this.caseRoot,
      "prd/expected-outputs/prd-write.core.output.json"
    ));
    const details = readJson<PrdWriteOutput>(path.join(
      this.caseRoot,
      "prd/expected-outputs/prd-write.details.output.json"
    ));
    core.prd_artifact.markdown_ref = prdRef;
    details.prd_artifact.markdown_ref = prdRef;
    const corePath = path.join(outputDir, "prd-write.core.json");
    const detailsPath = path.join(outputDir, "prd-write.details.json");
    writeJsonAtomic(corePath, core);
    writeJsonAtomic(detailsPath, details);

    return {
      thinkingPath: path.join(
        this.caseRoot,
        "prd/expected-outputs/prd-thinking.output.json"
      ),
      confirmedLedgerPath: path.join(
        this.caseRoot,
        "prd/decision-ledger.confirmed.json"
      ),
      corePath,
      detailsPath,
      reviewTemplatePath: path.join(this.caseRoot, "prd/prd-review.template.json"),
      p01: readJson(path.join(this.caseRoot, "prd/expected-decisions/prd-p01.approval.json")),
      p02: readJson(path.join(this.caseRoot, "prd/expected-decisions/prd-p02.approval.json")),
      p03: readJson(path.join(this.caseRoot, "prd/expected-decisions/prd-p03.approval.json")),
      prdRef,
    };
  }

  getPrdReportRefs(taskId: string) {
    const base = `repo://context-workspace/workspace/agent-runs/${safeSlug(taskId)}`;
    return {
      thinkingRef: `${base}/reports/prd-thinking.json`,
      ledgerRef: `${base}/decisions/decision-ledger.json`,
      reviewRef: `${base}/reports/prd-review.json`,
    };
  }

  prepareChangeAnalysis(state: TaskState, message: string): ChangeAnalysisAssets {
    if (!/(目标文章|目标标签|内容失效|自动停用|下线|标签删除)/.test(message)) {
      throw new Error(
        "当前本地 Provider 只覆盖“目标文章下线或目标标签删除后自动停用别名”的可复现变更场景"
      );
    }
    const slug = safeSlug(state.task_id);
    const changeId = `change-target-unavailable-${slug}`.slice(0, 80);
    const snapshotRef = `repo://context-workspace/workspace/snapshots/${changeId}/manifest.json`;
    const reportRef = `repo://context-workspace/workspace/reports/change-impact-${slug}.json`;
    const prdAssets = this.getPrdAssets(state.task_id);
    const prdReportRefs = this.getPrdReportRefs(state.task_id);
    const refMap = new Map<string, string>([
      ["repo://context-workspace/workspace/prd/help-center-search.md", prdAssets.prdRef],
      ["repo://context-workspace/workspace/reports/prd-review.json", prdReportRefs.reviewRef],
      ["repo://context-workspace/workspace/decisions/decision-ledger.json", prdReportRefs.ledgerRef],
    ]);
    const input = readJson<ChangeRequestInput>(path.join(
      this.caseRoot,
      "change/change-request.input.json"
    ));
    input.request_meta.task_id = state.task_id;
    input.request_meta.request_id = `request-${slug}`;
    input.request_meta.current_state = "CHANGE_ANALYZING";
    input.request_meta.requested_at = new Date().toISOString();
    input.change_request.change_id = changeId;
    input.change_request.change_text = message;
    input.change_request.received_at = new Date().toISOString();
    input.change_request.source_refs = input.change_request.source_refs.map(
      (ref) => refMap.get(ref) ?? ref
    );
    input.task_snapshot = {
      source_state: "DELIVERED",
      material_version: state.material_version === "0.1.0" ? "0.2.0" : state.material_version,
      context_version: "0.1.1",
      decision_ledger_version: "0.2.0",
      prd_version: "0.2.0",
      plan_version: "0.1.0",
    };
    input.artifact_refs = input.artifact_refs.map((ref) => refMap.get(ref) ?? ref);

    const analysis = readJson<ChangeAnalysisOutput>(path.join(
      this.caseRoot,
      "change/expected-outputs/change-impact.analysis.json"
    ));
    analysis.change_id = changeId;
    analysis.snapshot_ref = snapshotRef;
    analysis.change_summary.source_refs = analysis.change_summary.source_refs.map(
      (ref) => refMap.get(ref) ?? ref
    );
    analysis.affected_items = analysis.affected_items.map((item) => ({
      ...item,
      artifact_ref: refMap.get(item.artifact_ref) ?? item.artifact_ref,
    }));
    analysis.unaffected_items = analysis.unaffected_items.map((item) => ({
      ...item,
      artifact_ref: refMap.get(item.artifact_ref) ?? item.artifact_ref,
    }));
    const outputDir = this.outputDir(slug);
    const inputPath = path.join(outputDir, "change-request.json");
    const analysisPath = path.join(outputDir, "change-impact.analysis.json");
    writeJsonAtomic(inputPath, input);
    writeJsonAtomic(analysisPath, analysis);
    return { inputPath, analysisPath, reportRef, changeId };
  }

  prepareChangeReplan(state: TaskState, assets: ChangeAnalysisAssets): ChangeReplanAssets {
    const slug = safeSlug(state.task_id);
    const planRef = `repo://context-workspace/workspace/plans/help-center-search-${slug}-replan.json`;
    const replan = readJson<ReplanOutput>(path.join(
      this.caseRoot,
      "change/expected-outputs/change-impact.replan.json"
    ));
    replan.change_id = assets.changeId;
    replan.analysis_ref = assets.reportRef;
    replan.analysis_sha256 = sha256Buffer(
      fs.readFileSync(repoRefToPath(assets.reportRef, PROJECT_ROOT))
    );
    replan.snapshot_ref = `repo://context-workspace/workspace/snapshots/${assets.changeId}/manifest.json`;
    replan.plan.plan_id = `replan-${assets.changeId}`;
    replan.plan.previous_version = "0.1.0";
    replan.plan.version = "0.2.0";
    replan.plan.status = "DRAFT";
    const prdAssets = this.getPrdAssets(state.task_id);
    const prdReportRefs = this.getPrdReportRefs(state.task_id);
    const refMap = new Map<string, string>([
      ["repo://context-workspace/workspace/prd/help-center-search.md", prdAssets.prdRef],
      ["repo://context-workspace/workspace/reports/prd-review.json", prdReportRefs.reviewRef],
      ["repo://context-workspace/workspace/decisions/decision-ledger.json", prdReportRefs.ledgerRef],
      ["repo://context-workspace/workspace/reports/change-impact.json", assets.reportRef],
    ]);
    replan.plan.steps = replan.plan.steps.map((step) => ({
      ...step,
      input_refs: step.input_refs.map((ref) => refMap.get(ref) ?? ref),
    }));
    replan.plan.preserved_artifacts = replan.plan.preserved_artifacts.map(
      (ref) => refMap.get(ref) ?? ref
    );
    replan.plan.preserved_items = replan.plan.preserved_items.map((item) => ({
      ...item,
      artifact_ref: refMap.get(item.artifact_ref) ?? item.artifact_ref,
    }));
    replan.plan.deprecated_artifacts = replan.plan.deprecated_artifacts.map(
      (ref) => refMap.get(ref) ?? ref
    );
    const replanPath = path.join(this.outputDir(slug), "change-impact.replan.json");
    writeJsonAtomic(replanPath, replan);

    const approval = readJson<Record<string, unknown>>(path.join(
      this.caseRoot,
      "change/expected-decisions/change-r01.approval.json"
    ));
    approval.change_id = assets.changeId;
    approval.snapshot_ref = replan.snapshot_ref;
    approval.analysis_ref = assets.reportRef;
    approval.plan_ref = planRef;
    approval.approved_plan_version = replan.plan.version;
    approval.approved_plan_sha256 = hashReplanForApproval(replan);
    approval.preserved_artifact_refs = Array.isArray(approval.preserved_artifact_refs)
      ? approval.preserved_artifact_refs.map((ref) =>
          typeof ref === "string" ? refMap.get(ref) ?? ref : ref
        )
      : [];
    approval.deprecated_artifact_refs = Array.isArray(approval.deprecated_artifact_refs)
      ? approval.deprecated_artifact_refs.map((ref) =>
          typeof ref === "string" ? refMap.get(ref) ?? ref : ref
        )
      : [];
    return { replanPath, planRef, approval };
  }

  private assertSupportedMaterialPath(materialPath: string): void {
    const resolved = path.resolve(materialPath);
    const supportedRoot = path.resolve(this.caseRoot);
    if (
      resolved !== supportedRoot &&
      !resolved.startsWith(supportedRoot + path.sep)
    ) {
      throw new Error(
        `当前本地 Provider 只支持帮助中心搜索案例材料: ${path.join(this.caseRoot, "source-materials")}`
      );
    }
  }

  private outputDir(slug: string): string {
    return path.join(PROJECT_ROOT, "runtime/provider-output", slug);
  }
}

function safeSlug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "agent-task";
}
