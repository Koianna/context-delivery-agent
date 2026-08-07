#!/usr/bin/env npx tsx
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { AgentOrchestrator } from "./agent/orchestrator.js";
import type { AgentResponse } from "./agent/types.js";

async function main() {
  const args = process.argv.slice(2);
  const agent = new AgentOrchestrator();
  const taskId = argVal(args, "--task-id");
  const projectId = argVal(args, "--project");
  const materialPath = argVal(args, "--material");
  const debug = args.includes("--debug");
  const oneShot = argVal(args, "--message");
  if (oneShot) {
    printResponse(await agent.handleMessage(oneShot, { taskId, projectId, materialPath, debug }));
    return;
  }

  console.log("Context 工程与需求交付 Agent");
  console.log("请直接描述目标，例如：请整理这份会议记录，先不要写 PRD。输入 exit 结束会话。\n");
  const terminal = readline.createInterface({ input, output });
  while (true) {
    const message = (await terminal.question("你：")).trim();
    if (["exit", "quit", "退出"].includes(message.toLowerCase())) break;
    printResponse(await agent.handleMessage(message, { taskId, projectId, materialPath, debug }));
    console.log();
  }
  terminal.close();
}

function printResponse(response: AgentResponse) {
  console.log(`\nAgent：${response.message}`);
  console.log(`\n当前阶段：${response.state.name}`);
  if (response.skill) console.log(`执行能力：${response.skill}`);
  console.log(`生成方式：${response.provider.label}`);
  if (response.artifacts.length) {
    console.log("\n产物：");
    response.artifacts.forEach((artifact) => console.log(`- ${artifact.label}: ${artifact.ref}`));
  }
  if (response.confirmation) {
    console.log(`\n需要你判断：${response.confirmation.title}`);
    response.confirmation.items.forEach((item, index) => {
      const value = item.proposed_value ?? item.question ?? item.reason ?? item.change_id ?? "请查看确认项";
      const ids = [item.proposal_id, item.item_id].filter((value): value is string => typeof value === "string");
      const id = ids.length ? ` [${ids.join(" / ")}]` : "";
      console.log(`${index + 1}.${id} ${String(value)}`);
    });
  }
  if (response.next_steps.length) {
    console.log("\n你可以回复：");
    response.next_steps.forEach((step) => console.log(`- ${step}`));
  }
  if (response.debug) {
    console.log(`\n调试：task=${response.debug.task_id}, state=${response.debug.state_id}`);
  }
}

function argVal(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
