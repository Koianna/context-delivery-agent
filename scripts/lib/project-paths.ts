import * as path from "node:path";

export const RESERVED_PROJECT_IDS = new Set(["manual-numbered-eval", "workspace-numbered-eval"]);
import { PROJECT_ROOT } from "./config.js";

export function contextRootPath(projectId?: string, root = PROJECT_ROOT): string {
  return path.join(root, "context-workspace/context", safeProjectSlug(projectId ?? "default-project"));
}

export function contextIndexPath(projectId?: string, root = PROJECT_ROOT): string {
  return path.join(contextRootPath(projectId, root), "INDEX.md");
}

export function contextIndexRef(projectId?: string): string {
  return `repo://context-workspace/context/${safeProjectSlug(projectId ?? "default-project")}/INDEX.md`;
}

export function contextRootRef(projectId?: string): string {
  return contextIndexRef(projectId).replace(/INDEX\.md$/, "");
}

export function contextDocumentRef(projectId: string | undefined, relativePath: string): string {
  return `${contextRootRef(projectId)}${relativePath.replaceAll("\\", "/")}`;
}

/** 历史 PRD 目录（workspace/prd/，当前只含 .gitkeep 时为空集） */
export function prdDirectoryPath(root = PROJECT_ROOT): string {
  return path.join(root, "context-workspace/workspace/prd");
}

export function prdFileRef(relativePath: string): string {
  return `repo://context-workspace/workspace/prd/${relativePath.replaceAll("\\", "/")}`;
}

/** 通用材料分析报告 fallback 路径（缺失时使用 runs://<task>/reports/material-analysis.json） */
export function materialAnalysisReportRef(): string {
  return "repo://context-workspace/workspace/reports/material-analysis.json";
}

export function safeProjectSlug(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error("project_id 只能包含字母、数字、下划线或连字符，长度不超过 64");
  }
  if (RESERVED_PROJECT_IDS.has(normalized)) {
    throw new Error(`project_id ${normalized} 是保留的测试项目标识，不允许创建项目目录`);
  }
  return normalized;
}
