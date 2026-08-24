import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChangeRequestInput, ChangeSnapshotManifest } from "./change-types.js";
import { pathToRepoRef, readJson, repoRefToPath, writeJsonAtomic } from "./repository.js";

export function sha256Buffer(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * 计算 Markdown 材料的"正文"哈希（去除 YAML frontmatter）。
 *
 * 目的：材料的去重与 source_id 只跟内容有关，不应受 frontmatter 元信息（task_goal、
 * source_owner 等）变化影响。产品经理修正元信息不应被误判为"新材料"。
 *
 * 若输入不是 Markdown 或没有 frontmatter，退化为对整段内容做 sha256。
 */
export function materialBodySha256(content: Buffer | string): string {
  const text = typeof content === "string" ? content : content.toString("utf-8");
  const body = stripFrontmatter(text);
  return sha256Buffer(body);
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return text;
  return text.slice(end + 5);
}

export function createChangeSnapshot(
  input: ChangeRequestInput,
  taskId: string,
  root: string,
  createdAt: string
): { status: "CREATED" | "UNCHANGED"; manifest: ChangeSnapshotManifest; manifestRef: string } {
  const changeId = input.change_request.change_id;
  if (!/^[a-z0-9-]+$/.test(changeId)) throw new Error("change_id 只能包含小写字母、数字和连字符");
  const snapshotRoot = path.join(root, "context-workspace/workspace/snapshots", changeId);
  const manifestPath = path.join(snapshotRoot, "manifest.json");
  const artifacts = input.artifact_refs.map((artifactRef) => {
    const sourcePath = repoRefToPath(artifactRef, root);
    if (!fs.existsSync(sourcePath)) throw new Error(`快照来源不存在: ${artifactRef}`);
    const relative = artifactRef.slice("repo://".length);
    const snapshotPath = path.join(snapshotRoot, "artifacts", relative);
    const content = fs.readFileSync(sourcePath);
    return {
      artifact_ref: artifactRef,
      snapshot_ref: pathToRepoRef(snapshotPath, root),
      sha256: sha256Buffer(content),
      size_bytes: content.byteLength,
      snapshotPath,
      content,
    };
  });
  const manifest: ChangeSnapshotManifest = {
    snapshot_id: `snapshot-${changeId}`,
    manifest_version: "0.1.0",
    change_id: changeId,
    task_id: taskId,
    source_state: input.task_snapshot.source_state,
    created_at: createdAt,
    baseline_versions: input.task_snapshot,
    artifacts: artifacts.map(({ snapshotPath: _snapshotPath, content: _content, ...artifact }) => artifact),
  };

  if (fs.existsSync(manifestPath)) {
    const existing = readJson<ChangeSnapshotManifest>(manifestPath);
    const same = existing.change_id === manifest.change_id
      && existing.task_id === manifest.task_id
      && existing.source_state === manifest.source_state
      && JSON.stringify(existing.baseline_versions) === JSON.stringify(manifest.baseline_versions)
      && existing.artifacts.length === manifest.artifacts.length
      && existing.artifacts.every((artifact, index) =>
        artifact.artifact_ref === manifest.artifacts[index]?.artifact_ref
        && artifact.sha256 === manifest.artifacts[index]?.sha256
      );
    if (!same) throw new Error(`快照 ${changeId} 已存在但基线内容不同`);
    const integrityErrors = validateSnapshotIntegrity(pathToRepoRef(manifestPath, root), root);
    if (integrityErrors.length) throw new Error(`已有快照完整性校验失败:\n${integrityErrors.join("\n")}`);
    return { status: "UNCHANGED", manifest: existing, manifestRef: pathToRepoRef(manifestPath, root) };
  }

  for (const artifact of artifacts) writeBufferAtomic(artifact.snapshotPath, artifact.content);
  writeJsonAtomic(manifestPath, manifest);
  return { status: "CREATED", manifest, manifestRef: pathToRepoRef(manifestPath, root) };
}

export function validateSnapshotIntegrity(manifestRef: string, root: string): string[] {
  const errors: string[] = [];
  try {
    const manifest = readJson<ChangeSnapshotManifest>(repoRefToPath(manifestRef, root));
    for (const artifact of manifest.artifacts) {
      const snapshotPath = repoRefToPath(artifact.snapshot_ref, root);
      if (!fs.existsSync(snapshotPath)) {
        errors.push(`快照文件不存在: ${artifact.snapshot_ref}`);
        continue;
      }
      const content = fs.readFileSync(snapshotPath);
      if (sha256Buffer(content) !== artifact.sha256 || content.byteLength !== artifact.size_bytes) {
        errors.push(`快照文件完整性校验失败: ${artifact.snapshot_ref}`);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

export function currentArtifactsMatchSnapshot(manifestRef: string, root: string): boolean {
  const manifest = readJson<ChangeSnapshotManifest>(repoRefToPath(manifestRef, root));
  return manifest.artifacts.every((artifact) => {
    const target = repoRefToPath(artifact.artifact_ref, root);
    return fs.existsSync(target) && sha256Buffer(fs.readFileSync(target)) === artifact.sha256;
  });
}

export function restoreChangeSnapshot(
  manifestRef: string,
  root: string
): { status: "RESTORED" | "UNCHANGED"; restored_refs: string[]; source_state: ChangeSnapshotManifest["source_state"] } {
  const integrityErrors = validateSnapshotIntegrity(manifestRef, root);
  if (integrityErrors.length) throw new Error(`快照不可恢复:\n${integrityErrors.join("\n")}`);
  const manifest = readJson<ChangeSnapshotManifest>(repoRefToPath(manifestRef, root));
  const restored: string[] = [];
  for (const artifact of manifest.artifacts) {
    const snapshotContent = fs.readFileSync(repoRefToPath(artifact.snapshot_ref, root));
    const targetPath = repoRefToPath(artifact.artifact_ref, root);
    const current = fs.existsSync(targetPath) ? fs.readFileSync(targetPath) : null;
    if (!current || sha256Buffer(current) !== artifact.sha256) {
      writeBufferAtomic(targetPath, snapshotContent);
      restored.push(artifact.artifact_ref);
    }
  }
  return { status: restored.length ? "RESTORED" : "UNCHANGED", restored_refs: restored, source_state: manifest.source_state };
}

function writeBufferAtomic(filePath: string, content: Buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}
