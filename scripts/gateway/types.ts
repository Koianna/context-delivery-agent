import type { AgentResponse } from "../agent/types.js";
import type { StateId, TaskState } from "../lib/types.js";

export interface ExternalAgentClient {
  id: string;
  name?: string;
  version?: string;
}

export interface ExternalAgentMaterial {
  name: string;
  content: string;
  source_type?: string;
  source_owner?: string;
  source_time?: string;
  is_complete?: boolean;
}

export interface ExternalAgentRequest {
  protocol_version?: string;
  request_id: string;
  task_id?: string;
  project_id?: string;
  session_id?: string;
  message: string;
  material_path?: string;
  materials?: ExternalAgentMaterial[];
  client?: ExternalAgentClient;
  debug?: boolean;
}

export type GatewayStatus = "SUCCESS" | "INVALID_REQUEST" | "RUNTIME_ERROR";

export interface ExternalAgentResponse {
  protocol_version: "0.1";
  request_id: string;
  status: GatewayStatus;
  agent_response?: AgentResponse;
  runtime: {
    task_id: string | null;
    session_id: string | null;
    current_state: StateId | null;
    provider: string | null;
    runtime_version: string;
  };
  error: {
    code: string;
    message: string;
  } | null;
}

export function runtimeSummary(
  state: TaskState | null,
  response?: AgentResponse
): ExternalAgentResponse["runtime"] {
  return {
    task_id: state?.task_id ?? response?.debug?.task_id ?? null,
    session_id: state?.session_id ?? null,
    current_state: state?.current_state ?? response?.state.id ?? null,
    provider: response?.provider.id ?? null,
    runtime_version: "0.1.0",
  };
}
