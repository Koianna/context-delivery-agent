import * as path from "node:path";
import { PROJECT_ROOT } from "./config.js";

export function contextRootPath(projectId?: string, root = PROJECT_ROOT): string {
  return path.join(root, "context-workspace/projects", safeProjectSlug(projectId ?? "default-project"), "context");
}

export function contextIndexPath(projectId?: string, root = PROJECT_ROOT): string {
  return path.join(contextRootPath(projectId, root), "INDEX.md");
}

export function contextIndexRef(projectId?: string): string {
  return `repo://context-workspace/projects/${safeProjectSlug(projectId ?? "default-project")}/context/INDEX.md`;
}

export function contextRootRef(projectId?: string): string {
  return contextIndexRef(projectId).replace(/INDEX\.md$/, "");
}

export function contextDocumentRef(projectId: string | undefined, relativePath: string): string {
  return `${contextRootRef(projectId)}${relativePath.replaceAll("\\", "/")}`;
}

export function safeProjectSlug(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error("project_id 只能包含字母、数字、下划线或连字符，长度不超过 64");
  }
  return normalized;
}
