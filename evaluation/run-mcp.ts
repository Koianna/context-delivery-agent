#!/usr/bin/env npx tsx
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { PROJECT_ROOT } from "../scripts/lib/config.js";
import { agentRunsPath } from "../scripts/lib/repository.js";
import { isolateRuntime } from "./runtime-isolation.js";

isolateRuntime(PROJECT_ROOT);

const taskId = "mcp-inline-material-demo";
const projectId = "mcp-inline-demo";
const sourceText = "客服反馈：用户说‘手机号不用了’，但这不一定等于修改手机号。\n会议决定：先整理材料，不直接写 PRD。";
const requests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "context_delivery", arguments: {
    project_id: projectId,
    task_id: taskId,
    session_id: "mcp-session-a",
    message: "请整理这份会议记录，先不要写 PRD",
    materials: [
      { name: "会议记录.md", content: sourceText, source_type: "MEETING_NOTE", source_owner: "产品团队", is_complete: true },
      { name: "产品现状.md", content: "当前帮助中心约有 120 篇文章，文章标题以正式表达为主。", source_type: "PRODUCT_DOC", source_owner: "产品团队", is_complete: true },
    ],
  } } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "context_delivery", arguments: {
    project_id: projectId,
    task_id: taskId,
    session_id: "mcp-session-b",
    message: "暂不更新稳定 Context",
  } } },
];

clear();
const output = execFileSync(process.execPath, ["--import", "tsx", path.join(PROJECT_ROOT, "scripts/agent-mcp.ts")], {
  cwd: PROJECT_ROOT,
  input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
  encoding: "utf-8",
  env: { ...process.env, MODEL_PROVIDER: "workspace" },
});
const messages = output.trim().split("\n").map((line) => JSON.parse(line) as JsonRpcMessage);
const first = structured(messages[2]);
const second = structured(messages[3]);
const draftRoot = path.join(PROJECT_ROOT, "context-workspace/drafts", projectId);
const sourceFound = findText(draftRoot, sourceText);
const unifiedManifestPath = path.join(PROJECT_ROOT, ".cache/manifests", projectId, "material-manifest.json");
const unifiedManifest = fs.existsSync(unifiedManifestPath)
  ? JSON.parse(fs.readFileSync(unifiedManifestPath, "utf-8")) as { ingestions?: Array<{ task_id?: string; task_goal?: string; materials?: Array<{ source_id?: string; original_name?: string; stored_name?: string }> }> }
  : null;
const taskSourceDir = path.join(draftRoot, "source-materials", taskId);
const sourceMarkdownFiles = fs.existsSync(taskSourceDir)
  ? fs.readdirSync(taskSourceDir).filter((name) => /\.md$/i.test(name))
  : [];
const taskIngestion = unifiedManifest?.ingestions?.find((item) => item.task_id === taskId);
const results = [
  check("MCP-01", messages[0]?.result?.serverInfo?.name === "context-delivery-agent", "MCP Server 可初始化"),
  check("MCP-02", messages[1]?.result?.tools?.some((tool) => tool.name === "context_delivery") === true, "MCP 暴露 context_delivery 工具"),
  check("MCP-03", first?.state?.id === "WAITING_CONTEXT_CONFIRM", "自然语言整理请求进入 Context 分支并停在 CP-C01，而不是 PRD 分支"),
  check("MCP-04", first?.skill?.includes("material-ingest") === true && sourceFound, "工具调用执行材料登记并保留原文到 drafts"),
  check("MCP-04B", unifiedManifest?.ingestions?.some((item) => item.task_id === taskId && item.task_goal === "请整理这份会议记录，先不要写 PRD" && item.materials?.some((material) => material.original_name === "会议记录.md")) === true && !fs.existsSync(path.join(draftRoot, "source-materials", taskId, "ingest-manifest.json")), "内联材料接入信息合并到项目级材料清单"),
  check("MCP-04C", sourceMarkdownFiles.length === 1 && sourceMarkdownFiles[0] === "materials.md" && taskIngestion?.materials?.length === 2 && taskIngestion.materials.every((material) => material.stored_name === "materials.md") && new Set(taskIngestion.materials.map((material) => material.source_id)).size === 2, "同一次输入只写一个 Markdown 原文包，同时逐条保留逻辑来源登记"),
  check("MCP-04A", first?.execution_authority === "RUNTIME_ONLY" && first?.execution_status === "WAITING_USER_CONFIRMATION" && first?.artifacts?.some((item) => item.label === "结构化整理稿" && item.ref?.includes(`context-workspace/workspace/projects/${projectId}/materials/meeting-notes/`) && item.ref?.endsWith(`${taskId}.md`)) === true, "等待确认时返回 Runtime 发布的项目级会议整理稿"),
  check("MCP-05", second?.task_id === taskId && second?.state?.id === "CONTEXT_TASK_COMPLETED", "确认轮次复用同一 task_id 并由 Runtime 处理"),
];
const passed = results.filter((item) => item.passed).length;
console.log(JSON.stringify({ evaluation_id: "external-agent-mcp-inline-material", summary: { total: results.length, passed, failed: results.length - passed }, results }, null, 2));
clear();
if (passed !== results.length) process.exit(1);

function structured(message: JsonRpcMessage): Structured | null {
  const content = message.result?.structuredContent;
  return content && typeof content === "object" ? content as Structured : null;
}
function findText(root: string, text: string): boolean {
  if (!fs.existsSync(root)) return false;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory() && findText(file, text)) return true;
    if (entry.isFile() && fs.readFileSync(file, "utf-8").includes(text)) return true;
  }
  return false;
}
function clear() {
  for (const file of ["task-state.json", "pending-confirmations.json", "task-events.jsonl"]) fs.rmSync(path.join(PROJECT_ROOT, "runtime", file), { force: true });
  for (const target of [
    path.join(PROJECT_ROOT, "runtime/provider-output"),
    path.join(PROJECT_ROOT, "context-workspace/drafts", projectId),
    path.join(PROJECT_ROOT, "context-workspace/context", projectId),
    path.join(PROJECT_ROOT, "context-workspace/workspace/projects", projectId),
    agentRunsPath(taskId),
    path.join(PROJECT_ROOT, ".cache/manifests", projectId),
  ]) fs.rmSync(target, { recursive: true, force: true });
}
function check(caseId: string, passed: boolean, detail: string) { return { case_id: caseId, passed, detail }; }
interface JsonRpcMessage { result?: { serverInfo?: { name?: string }; tools?: Array<{ name?: string }>; structuredContent?: unknown } }
interface Structured { state?: { id?: string }; skill?: string; task_id?: string; execution_authority?: string; execution_status?: string; artifacts?: Array<{ label?: string; ref?: string }> }
