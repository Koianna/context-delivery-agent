import * as fs from "node:fs";
import * as path from "node:path";
import type { PrdArtifactDescriptor, PrdReviewOutput } from "./prd-types.js";
import type { TaskState } from "./types.js";
import { sha256Buffer } from "./change-snapshot.js";
import {
  parseFrontmatter,
  pathToRepoRef,
  readJson,
  repoRefToPath,
  writeJsonAtomic,
} from "./repository.js";

export interface PrdRecoveryEntry {
  task_id: string;
  project_id: string;
  artifact_id: string;
  version: string;
  phase: PrdArtifactDescriptor["phase"];
  prd_ref: string;
  snapshot_ref: string;
  file_sha256: string;
  body_sha256: string;
  size_bytes: number;
  created_at: string;
}

export interface PrdRecoveryManifest {
  manifest_version: "0.1.0";
  artifact_id: string;
  entries: PrdRecoveryEntry[];
}

export type PrdIntegrityResult =
  | { status: "VALID"; prd_ref: string; entry?: PrdRecoveryEntry }
  | { status: "RECOVERED"; prd_ref: string; entry: PrdRecoveryEntry }
  | {
      status: "RECOVERY_REQUIRED";
      prd_ref: string;
      reason: "MISSING_WITHOUT_SNAPSHOT" | "VERSION_MISMATCH" | "HASH_MISMATCH" | "SNAPSHOT_INVALID";
      detail: string;
    };

export function defaultPrdRef(projectId: string, taskId: string): string {
  return `repo://context-workspace/workspace/prd/${safeSlug(projectId)}-${safeSlug(taskId)}.md`;
}

export function savePrdRecoverySnapshot(
  state: Pick<TaskState, "task_id" | "project_id">,
  artifact: PrdArtifactDescriptor,
  targetPath: string,
  root: string,
  createdAt: string,
): { manifest_ref: string; snapshot_ref: string; file_sha256: string; body_sha256: string } {
  const content = fs.readFileSync(targetPath);
  const document = parseFrontmatter(content.toString("utf-8"));
  if (document.metadata.version !== artifact.version) {
    throw new Error(`PRD 恢复快照版本不一致: 期望 ${artifact.version}, 当前 ${document.metadata.version ?? "missing"}`);
  }
  const fileSha256 = sha256Buffer(content);
  const bodySha256 = sha256Buffer(document.body);
  const recoveryRoot = recoveryRootPath(artifact.artifact_id, root);
  const snapshotPath = path.join(recoveryRoot, `${fileSha256}.md`);
  const manifestPath = path.join(recoveryRoot, "manifest.json");
  const snapshotRef = pathToRepoRef(snapshotPath, root);
  const manifestRef = pathToRepoRef(manifestPath, root);

  if (fs.existsSync(snapshotPath)) {
    if (sha256Buffer(fs.readFileSync(snapshotPath)) !== fileSha256) {
      throw new Error(`PRD 恢复快照内容损坏: ${snapshotRef}`);
    }
  } else {
    writeBufferAtomic(snapshotPath, content);
  }

  const entry: PrdRecoveryEntry = {
    task_id: state.task_id,
    project_id: state.project_id,
    artifact_id: artifact.artifact_id,
    version: artifact.version,
    phase: artifact.phase,
    prd_ref: artifact.markdown_ref,
    snapshot_ref: snapshotRef,
    file_sha256: fileSha256,
    body_sha256: bodySha256,
    size_bytes: content.byteLength,
    created_at: createdAt,
  };
  const existing = fs.existsSync(manifestPath)
    ? readJson<PrdRecoveryManifest>(manifestPath)
    : { manifest_version: "0.1.0" as const, artifact_id: artifact.artifact_id, entries: [] };
  if (existing.artifact_id !== artifact.artifact_id) {
    throw new Error(`PRD 恢复清单 artifact_id 冲突: ${manifestRef}`);
  }
  const sameVersion = existing.entries.find((item) =>
    item.task_id === entry.task_id && item.prd_ref === entry.prd_ref && item.version === entry.version
  );
  if (sameVersion && sameVersion.file_sha256 !== entry.file_sha256) {
    throw new Error(`PRD ${entry.version} 已存在不同内容的恢复快照`);
  }
  if (!sameVersion) existing.entries.push(entry);
  writeJsonAtomic(manifestPath, existing);

  const verified = validateRecoveryEntry(sameVersion ?? entry, root);
  if (verified) throw new Error(verified);
  return { manifest_ref: manifestRef, snapshot_ref: snapshotRef, file_sha256: fileSha256, body_sha256: bodySha256 };
}

export function ensureCurrentPrdIntegrity(
  state: TaskState,
  root: string,
  prdRef = defaultPrdRef(state.project_id, state.task_id),
  reviewRef?: string,
): PrdIntegrityResult {
  const targetPath = repoRefToPath(prdRef, root);
  const entry = findRecoveryEntry(state, prdRef, root);
  const review = readMatchingReview(reviewRef, state.prd_version, root);

  if (fs.existsSync(targetPath)) {
    const content = fs.readFileSync(targetPath);
    const document = parseFrontmatter(content.toString("utf-8"));
    if (document.metadata.version !== state.prd_version) {
      return {
        status: "RECOVERY_REQUIRED",
        prd_ref: prdRef,
        reason: "VERSION_MISMATCH",
        detail: `当前 PRD 版本为 ${document.metadata.version ?? "missing"}，Runtime 记录为 ${state.prd_version}`,
      };
    }
    const fileSha256 = sha256Buffer(content);
    const bodySha256 = sha256Buffer(document.body);
    if (entry) {
      const entryError = validateRecoveryEntry(entry, root);
      if (entryError) {
        return { status: "RECOVERY_REQUIRED", prd_ref: prdRef, reason: "SNAPSHOT_INVALID", detail: entryError };
      }
      if (fileSha256 !== entry.file_sha256 || bodySha256 !== entry.body_sha256) {
        return {
          status: "RECOVERY_REQUIRED",
          prd_ref: prdRef,
          reason: "HASH_MISMATCH",
          detail: "当前 PRD 内容与 Runtime 保存的恢复快照不一致，不允许静默覆盖",
        };
      }
    }
    if (review && review.prd_sha256 !== bodySha256) {
      return {
        status: "RECOVERY_REQUIRED",
        prd_ref: prdRef,
        reason: "HASH_MISMATCH",
        detail: "当前 PRD 正文与最近一次独立审核的正文哈希不一致",
      };
    }
    return { status: "VALID", prd_ref: prdRef, entry };
  }

  if (!entry) {
    return {
      status: "RECOVERY_REQUIRED",
      prd_ref: prdRef,
      reason: "MISSING_WITHOUT_SNAPSHOT",
      detail: `PRD ${state.prd_version} 文件缺失，且该旧任务没有可验证的恢复快照`,
    };
  }
  const entryError = validateRecoveryEntry(entry, root);
  if (entryError) {
    return { status: "RECOVERY_REQUIRED", prd_ref: prdRef, reason: "SNAPSHOT_INVALID", detail: entryError };
  }
  if (review && review.prd_sha256 !== entry.body_sha256) {
    return {
      status: "RECOVERY_REQUIRED",
      prd_ref: prdRef,
      reason: "SNAPSHOT_INVALID",
      detail: "恢复快照正文与最近一次独立审核的正文哈希不一致",
    };
  }
  const snapshotContent = fs.readFileSync(repoRefToPath(entry.snapshot_ref, root));
  writeBufferAtomic(targetPath, snapshotContent);
  if (sha256Buffer(fs.readFileSync(targetPath)) !== entry.file_sha256) {
    throw new Error(`PRD 自动恢复后完整性校验失败: ${prdRef}`);
  }
  return { status: "RECOVERED", prd_ref: prdRef, entry };
}

function findRecoveryEntry(state: TaskState, prdRef: string, root: string): PrdRecoveryEntry | undefined {
  const recoveryBase = path.join(root, "context-workspace/workspace/prd-recovery");
  if (!fs.existsSync(recoveryBase)) return undefined;
  const manifests = fs.readdirSync(recoveryBase, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => path.join(recoveryBase, item.name, "manifest.json"))
    .filter((filePath) => fs.existsSync(filePath));
  const matches = manifests.flatMap((manifestPath) => {
    try {
      return readJson<PrdRecoveryManifest>(manifestPath).entries;
    } catch {
      return [];
    }
  }).filter((entry) =>
    entry.task_id === state.task_id && entry.prd_ref === prdRef && entry.version === state.prd_version
  );
  if (matches.length > 1 && new Set(matches.map((entry) => entry.file_sha256)).size > 1) {
    throw new Error(`PRD ${state.prd_version} 存在冲突的恢复快照`);
  }
  return matches[0];
}

function validateRecoveryEntry(entry: PrdRecoveryEntry, root: string): string | null {
  try {
    const snapshotPath = repoRefToPath(entry.snapshot_ref, root);
    if (!fs.existsSync(snapshotPath)) return `PRD 恢复快照不存在: ${entry.snapshot_ref}`;
    const content = fs.readFileSync(snapshotPath);
    const document = parseFrontmatter(content.toString("utf-8"));
    if (content.byteLength !== entry.size_bytes || sha256Buffer(content) !== entry.file_sha256) {
      return `PRD 恢复快照文件完整性校验失败: ${entry.snapshot_ref}`;
    }
    if (document.metadata.version !== entry.version || sha256Buffer(document.body) !== entry.body_sha256) {
      return `PRD 恢复快照版本或正文完整性校验失败: ${entry.snapshot_ref}`;
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function readMatchingReview(reviewRef: string | undefined, version: string, root: string): PrdReviewOutput | undefined {
  if (!reviewRef) return undefined;
  try {
    const reviewPath = repoRefToPath(reviewRef, root);
    if (!fs.existsSync(reviewPath)) return undefined;
    const review = readJson<PrdReviewOutput>(reviewPath);
    return review.reviewed_prd_version === version ? review : undefined;
  } catch {
    return undefined;
  }
}

function recoveryRootPath(artifactId: string, root: string): string {
  return path.join(root, "context-workspace/workspace/prd-recovery", safeSlug(artifactId));
}

function safeSlug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "prd";
}

function writeBufferAtomic(filePath: string, content: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}
