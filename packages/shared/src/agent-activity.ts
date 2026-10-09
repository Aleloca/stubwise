import type { z } from "zod";
import type { agentActivitySchema } from "./schemas/agent-session.js";

export type AgentActivity = z.infer<typeof agentActivitySchema>;

const MAX_TARGET = 80;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function clip(value: string | null): string | null {
  if (value === null) return null;
  const first = value.split("\n")[0]!.trim();
  return first.length > MAX_TARGET ? `${first.slice(0, MAX_TARGET - 1)}…` : first;
}

/**
 * Traduce un evento di sessione nella riga «ultima azione» (spec §8.2). È
 * l'UNICA regola: web e app la chiamano, e localizzano solo `kind`. Pura, non
 * lancia mai: un input malformato diventa `other`.
 */
export function describeAgentActivity(event: {
  type: string;
  data: Record<string, unknown>;
}): AgentActivity {
  if (event.type === "assistant_text") return { kind: "write", target: null };
  if (event.type !== "tool_use") return { kind: "other", target: null };
  const name = str(event.data["name"]);
  const input =
    typeof event.data["input"] === "object" && event.data["input"] !== null
      ? (event.data["input"] as Record<string, unknown>)
      : {};
  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return { kind: "edit", target: clip(str(input["file_path"]) ?? str(input["notebook_path"])) };
    case "Read":
      return { kind: "read", target: clip(str(input["file_path"])) };
    case "Bash":
      return { kind: "run", target: clip(str(input["command"])) };
    case "Grep":
    case "Glob":
      return { kind: "search", target: clip(str(input["pattern"])) };
    case "WebFetch":
    case "WebSearch":
      return { kind: "web", target: clip(str(input["url"]) ?? str(input["query"])) };
    case "Task":
    case "Agent":
      return { kind: "subagent", target: clip(str(input["description"])) };
    case null:
      return { kind: "other", target: null };
    default:
      if (name.endsWith("__ask_user")) return { kind: "ask", target: null };
      return { kind: "other", target: clip(name) };
  }
}
