import * as path from "node:path";
import {
  appendEvent,
  idempotencyKey,
  nowISO,
  PROJECT_ROOT,
  readTaskState,
  uid,
  writeTaskState,
} from "./lib/config.js";
import type {
  ContextAnalysisOutput,
  MaterialIngestInput,
  MaterialIngestOutput,
} from "./lib/context-types.js";
import { pathToRepoRef, readJson, repoRefToPath, writeJsonAtomic } from "./lib/repository.js";
import {
  validateContextAnalysis,
  validateMaterialOutput,
} from "./validate-skill-output.js";

export function recordContextAnalysis(input: {
  taskId: string;
  materialInputPath: string;
  materialOutputPath: string;
  contextOutputPath: string;
  root?: string;
  materialReportRef?: string;
  contextReportRef?: string;
}) {
  const root = input.root ?? PROJECT_ROOT;
  const state = readTaskState();
  if (!state || state.task_id !== input.taskId) {
    throw new Error(`任务 ${input.taskId} 不存在`);
  }
  if (state.current_state !== "CONTEXT_ANALYZING") {
    throw new Error(`当前状态 ${state.current_state} 不允许记录 Context 分析`);
  }

  const materialInput = readJson<MaterialIngestInput>(input.materialInputPath);
  const materialOutput = readJson<MaterialIngestOutput>(input.materialOutputPath);
  const contextOutput = readJson<ContextAnalysisOutput>(input.contextOutputPath);
  const errors = [
    ...validateMaterialOutput(materialInput, materialOutput, root),
    ...validateContextAnalysis(materialOutput, contextOutput, root, materialInput.project_id ?? state.project_id),
  ];
  if (errors.length) throw new Error(`Context 分析输出校验失败:\n${errors.join("\n")}`);

  const materialReport = input.materialReportRef
    ? repoRefToPath(input.materialReportRef, root)
    : path.join(root, "context-workspace/workspace/reports/material-analysis.json");
  const contextReport = input.contextReportRef
    ? repoRefToPath(input.contextReportRef, root)
    : path.join(root, "context-workspace/workspace/reports/context-analysis.json");
  writeJsonAtomic(materialReport, materialOutput);
  writeJsonAtomic(contextReport, contextOutput);

  state.latest_output_ref = pathToRepoRef(contextReport, root);
  state.material_version = "0.2.0";
  state.skill_versions["material-ingest"] = "0.2.0";
  state.skill_versions["context-maintain"] = "0.2.0";
  state.prompt_versions["material-ingest"] = "0.2.0";
  state.prompt_versions["context-maintain"] = "0.2.0";
  writeTaskState(state);
  appendEvent({
    event_id: uid(),
    event_type: "SKILL_RESULT",
    task_id: input.taskId,
    request_id: `req_${uid()}`,
    idempotency_key: idempotencyKey(input.taskId, "context_analysis"),
    timestamp: nowISO(),
    operator: "SYSTEM",
    current_state: state.current_state,
    previous_state: state.previous_state,
    skill_name: "context-maintain",
    skill_version: "0.2.0",
    prompt_version: "0.2.0",
    artifact_ref: pathToRepoRef(contextReport, root),
    details: {
      material_count: materialOutput.processing_summary.material_count,
      proposal_count: contextOutput.update_proposals.length,
      confirmation_count: contextOutput.update_proposals.filter(
        (proposal) => proposal.requires_confirmation
      ).length,
    },
  });
  return {
    material_report_ref: pathToRepoRef(materialReport, root),
    context_report_ref: pathToRepoRef(contextReport, root),
    material_count: materialOutput.processing_summary.material_count,
    proposal_count: contextOutput.update_proposals.length,
  };
}
