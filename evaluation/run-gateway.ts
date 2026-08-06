#!/usr/bin/env npx tsx
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT, readTaskState } from "../scripts/lib/config.js";
import { repoRefToPath } from "../scripts/lib/repository.js";

interface GatewayResponse {
  request_id: string;
  status: string;
  agent_response?: {
    state: { id: string };
    status: string;
    artifacts: Array<{ ref: string }>;
  };
  runtime: { task_id: string | null; current_state: string | null };
  error: { code: string; message: string } | null;
}

const taskId = "gateway-eval-demo";
const projectId = "evaluation-product";
const requests = [
  {
    protocol_version: "0.1",
    request_id: "gateway_req_001",
    task_id: taskId,
    project_id: projectId,
    session_id: "gateway_session_a",
    message: "整理并沉淀这份产品现状，先让我确认 Context 更新，不要写 PRD",
    materials: [{ name: "产品现状.md", content: "当前系统现状：产品支持提交材料并查看处理结果。", source_type: "PRODUCT_DOC", source_owner: "产品团队", source_time: "2026-08-06T10:00:00+08:00", is_complete: true }],
    client: { id: "external-host-a", name: "宿主 A", version: "1.0.0" },
  },
  {
    protocol_version: "0.1",
    request_id: "gateway_req_002",
    task_id: taskId,
    project_id: projectId,
    session_id: "gateway_session_b",
    message: "确认全部",
    client: { id: "external-host-b", name: "替换后的宿主 B", version: "2.0.0" },
  },
];

clearRuntime();
clearAgentArtifacts(taskId);
const input = `${requests.map((request) => JSON.stringify(request)).join("\n")}\nnot-json\n`;
const output = childProcess.execFileSync(
  process.execPath,
  ["--import", "tsx", path.join(PROJECT_ROOT, "scripts/agent-gateway.ts")],
  { cwd: PROJECT_ROOT, input, encoding: "utf-8", env: { ...process.env } }
);
const responses = output.trim().split("\n").map((line) => JSON.parse(line) as GatewayResponse);
const results = [
  check(
    "GATEWAY-01",
    responses[0]?.request_id === "gateway_req_001" &&
      responses[0]?.status === "SUCCESS" &&
      responses[0]?.agent_response?.state.id === "WAITING_CONTEXT_CONFIRM",
    "宿主 A 通过 Gateway 发送自然语言后，Runtime 路由到 Context 确认节点"
  ),
  check(
    "GATEWAY-02",
    responses[1]?.request_id === "gateway_req_002" &&
      responses[1]?.runtime.task_id === taskId &&
      responses[1]?.agent_response?.state.id === "CONTEXT_TASK_COMPLETED",
    "宿主 B 替换宿主 A 后复用同一 task_id 和 Runtime 状态完成确认"
  ),
  check(
    "GATEWAY-03",
    responses[1]?.agent_response?.artifacts.some((artifact) => fileExists(artifact.ref)) === true,
    "Gateway 响应保留 Runtime 生成的业务产物引用"
  ),
  check(
    "GATEWAY-04",
    responses[2]?.status === "INVALID_REQUEST" &&
      responses[2]?.error?.code === "INVALID_JSON" &&
      readTaskState()?.current_state === "CONTEXT_TASK_COMPLETED",
    "非法协议输入只返回校验错误，不改变业务状态"
  ),
];

const passed = results.filter((result) => result.passed).length;
const report = {
  evaluation_id: "external-agent-gateway",
  eval_set_version: "0.1.0",
  git_commit: childProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf-8" }).trim(),
  summary: { total: results.length, passed, failed: results.length - passed },
  results,
};
console.log(JSON.stringify(report, null, 2));
clearRuntime();
clearAgentArtifacts(taskId);
if (passed !== results.length) process.exit(1);

function check(caseId: string, passed: boolean, detail: string) {
  return { case_id: caseId, passed, detail };
}

function fileExists(ref: string): boolean {
  try { return fs.existsSync(repoRefToPath(ref, PROJECT_ROOT)); } catch { return false; }
}

function clearRuntime() {
  for (const file of ["task-state.json", "pending-confirmations.json", "task-events.jsonl"]) {
    fs.rmSync(path.join(PROJECT_ROOT, "runtime", file), { force: true });
  }
  fs.rmSync(path.join(PROJECT_ROOT, "runtime/provider-output"), { recursive: true, force: true });
}

function clearAgentArtifacts(dynamicTaskId: string) {
  const slug = dynamicTaskId.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const changeId = `change-target-unavailable-${slug}`.slice(0, 80);
  for (const target of [
    path.join(PROJECT_ROOT, "context-workspace/workspace/agent-runs", slug),
    path.join(PROJECT_ROOT, "context-workspace/drafts", projectId),
    path.join(PROJECT_ROOT, "context-workspace/context", projectId),
    path.join(PROJECT_ROOT, "context-workspace/workspace/projects", projectId, "materials"),
    path.join(PROJECT_ROOT, "context-workspace/workspace/prd", `${projectId}-${slug}.md`),
    path.join(PROJECT_ROOT, "context-workspace/workspace/reports", `change-impact-${slug}.json`),
    path.join(PROJECT_ROOT, "context-workspace/workspace/plans", `${projectId}-${slug}-replan.json`),
    path.join(PROJECT_ROOT, "context-workspace/workspace/snapshots", changeId),
  ]) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}
