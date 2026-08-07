#!/usr/bin/env npx tsx
import { inspectModelProviderConfig } from "./lib/model-provider-config.js";

const status = inspectModelProviderConfig();
console.log(JSON.stringify({
  provider: status.provider,
  mode: status.mode,
  ready: status.ready,
  model: status.model,
  api_key_env: status.api_key_env,
  api_key_configured: status.api_key_configured,
  base_url: status.base_url,
  issues: status.issues,
  message: status.ready
    ? "真实模型 Provider 配置完整，可以启动 Runtime。"
    : "真实模型 Provider 尚未就绪；Runtime 不会生成占位 PRD。",
}, null, 2));
if (!status.ready) process.exitCode = 1;
