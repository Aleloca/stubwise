// apps/worker/src/sessions/stream-parser.ts
import type { AgentSessionEventType } from "@stubwise/shared";
import { extractUsage } from "../agent/claude-cli.js";
import type { AgentRunResult } from "../agent/runner.js";

/**
 * Lettura dello stdout di `claude -p --output-format stream-json` (CLI
 * 2.1.287, tracce in fixtures/). Tutto PURO e difensivo: una riga che non si
 * capisce si scarta, non lancia. Comportamenti verificati e su cui questo
 * modulo si appoggia: vedi l'intestazione del piano A
 * (`docs/plans/2026-10-08-agent-sessions-a-backend.md`).
 */

export type CliStreamEvent = Record<string, unknown> & { type: string };

export interface SessionEventDraft {
  type: AgentSessionEventType;
  data: Record<string, unknown>;
}

const MAX_TOOL_RESULT = 16_384;
const MAX_TOOL_INPUT_STRING = 8_192;

export function parseStreamLine(line: string): CliStreamEvent | null {
  if (line.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const type = (parsed as Record<string, unknown>)["type"];
    return typeof type === "string" ? (parsed as CliStreamEvent) : null;
  } catch {
    return null;
  }
}

function contentBlocks(ev: CliStreamEvent): Record<string, unknown>[] {
  const message = ev["message"];
  if (typeof message !== "object" || message === null) return [];
  const content = (message as Record<string, unknown>)["content"];
  return Array.isArray(content)
    ? content.filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
    : [];
}

function clipInput(input: unknown): unknown {
  if (typeof input === "string") {
    return input.length > MAX_TOOL_INPUT_STRING
      ? `${input.slice(0, MAX_TOOL_INPUT_STRING)}…`
      : input;
  }
  if (Array.isArray(input)) return input.map(clipInput);
  if (typeof input === "object" && input !== null) {
    return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, clipInput(v)]));
  }
  return input;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "object" && c !== null && (c as Record<string, unknown>)["type"] === "text"
          ? String((c as Record<string, unknown>)["text"] ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

/** Eventi COMPLETI da salvare. I parziali (`stream_event`) non producono nulla qui. */
export function toSessionEvents(ev: CliStreamEvent): SessionEventDraft[] {
  if (ev.type === "assistant") {
    const out: SessionEventDraft[] = [];
    for (const block of contentBlocks(ev)) {
      if (block["type"] === "text" && typeof block["text"] === "string" && block["text"] !== "") {
        out.push({ type: "assistant_text", data: { text: block["text"] } });
      } else if (block["type"] === "tool_use") {
        out.push({
          type: "tool_use",
          data: { toolUseId: block["id"], name: block["name"], input: clipInput(block["input"]) },
        });
      }
    }
    return out;
  }
  if (ev.type === "user") {
    const out: SessionEventDraft[] = [];
    for (const block of contentBlocks(ev)) {
      if (block["type"] !== "tool_result") continue;
      const text = resultText(block["content"]);
      const truncated = text.length > MAX_TOOL_RESULT;
      out.push({
        type: "tool_result",
        data: {
          toolUseId: block["tool_use_id"],
          isError: block["is_error"] === true,
          content: truncated ? `${text.slice(0, MAX_TOOL_RESULT)}…` : text,
          ...(truncated ? { truncated: true } : {}),
        },
      });
    }
    return out;
  }
  if (ev.type === "result") {
    return [
      {
        type: "turn_end",
        data: {
          subtype: ev["subtype"] ?? null,
          isError: ev["is_error"] === true,
          costUsd: typeof ev["total_cost_usd"] === "number" ? ev["total_cost_usd"] : null,
        },
      },
    ];
  }
  return [];
}

/** Il delta di testo di un evento parziale, o null. */
export function partialTextOf(ev: CliStreamEvent): string | null {
  if (ev.type !== "stream_event") return null;
  const inner = ev["event"] as Record<string, unknown> | undefined;
  if (inner?.["type"] !== "content_block_delta") return null;
  const delta = inner["delta"] as Record<string, unknown> | undefined;
  return delta?.["type"] === "text_delta" && typeof delta["text"] === "string"
    ? delta["text"]
    : null;
}

export function capabilitiesOf(ev: CliStreamEvent): string[] | null {
  if (ev.type !== "system" || ev["subtype"] !== "init") return null;
  const caps = ev["capabilities"];
  return Array.isArray(caps) ? caps.filter((c): c is string => typeof c === "string") : [];
}

/**
 * Tiene l'ULTIMO `result`: costo e token sono cumulativi sul processo, e un
 * `result` di interruzione seguito da un messaggio non è l'esito del run.
 */
export class ResultTracker {
  private last: CliStreamEvent | null = null;

  observe(ev: CliStreamEvent): void {
    if (ev.type === "result") this.last = ev;
  }

  get hasResult(): boolean {
    return this.last !== null;
  }

  /** Testo dell'ultimo `result`, "" se assente o non stringa. */
  get lastResultText(): string {
    const text = this.last?.["result"];
    return typeof text === "string" ? text : "";
  }

  toRunResult(exitCode: number, fallback: string): AgentRunResult {
    if (this.last === null) return { output: fallback, exitCode };
    const result = this.last["result"];
    const usage = extractUsage(this.last);
    const sessionId = this.last["session_id"];
    return {
      output: typeof result === "string" ? result : fallback,
      exitCode,
      ...(usage !== undefined ? { usage } : {}),
      ...(typeof sessionId === "string" && sessionId !== "" ? { sessionId } : {}),
    };
  }
}
