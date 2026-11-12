import { splitSseFrames } from "@stubwise/shared";
import type * as Fake from "../../api";
import { myMailboxes, placeOf } from "./mailDrafts";

// La bozza di Claude nella Posta della build app (area 6, fetta 3): arriva a
// pezzi dallo stream SSE del server e resta una PROPOSTA — non salva e non
// spedisce mai; il testo lo mette nel campo chi scrive, e il salvataggio è
// il suo. Sul desktop passa dal main (`openStream`, come la chat con Claude:
// il token non lascia mai il main), sul web col fetch e il cookie.

type Mail = typeof Fake.mail;
type Outcome = Awaited<ReturnType<Mail["streamClaudeDraft"]>["result"]>;

const PATH = "/api/me/mail/drafts/claude";

type DraftEvent =
  | { type: "delta"; text: string }
  | { type: "done"; text: string; projectId: string | null; used: unknown[] }
  | { type: "error"; code: string };

/** I rifiuti del server, nelle parole del prototipo. */
function errorOf(code: string | undefined): Error {
  if (code === "invalid_hint") return new Error("invalid: hint");
  return new Error(code ?? "claude_unavailable");
}

const usedOf = (used: unknown[]): Outcome["used"] =>
  used.flatMap((u) => {
    const x = u as { taskId?: unknown; code?: unknown; title?: unknown; late?: unknown };
    return typeof x.taskId === "string" && typeof x.code === "string" && typeof x.title === "string"
      ? [{ taskId: x.taskId, code: x.code, title: x.title, late: x.late === true }]
      : [];
  });

/** Un frame SSE (`data: {json}`) della bozza, se è uno dei tre previsti. */
function parseFrame(raw: string): DraftEvent | null {
  const data = raw
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    const e = JSON.parse(data) as Record<string, unknown>;
    if (e.type === "delta" && typeof e.text === "string") return { type: "delta", text: e.text };
    if (e.type === "done" && typeof e.text === "string") {
      return { type: "done", text: e.text, projectId: typeof e.projectId === "string" ? e.projectId : null, used: Array.isArray(e.used) ? e.used : [] };
    }
    if (e.type === "error" && typeof e.code === "string") return { type: "error", code: e.code };
  } catch {
    // un frame che non si legge si salta
  }
  return null;
}

/** Il web: POST col cookie, poi lo stream SSE; restituisce come chiuderlo. */
function openFromBrowser(body: unknown, onEvent: (e: DraftEvent) => void, onEnd: (code?: string) => void): () => void {
  const abort = new AbortController();
  void (async () => {
    let res: Response;
    try {
      res = await fetch(PATH, {
        method: "POST",
        credentials: "include",
        headers: { accept: "text/event-stream", "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } catch {
      return onEnd();
    }
    if (!res.ok || !res.body) {
      const code = await res
        .json()
        .then((b: { code?: unknown }) => (typeof b?.code === "string" ? b.code : undefined))
        .catch(() => undefined);
      return onEnd(code ?? "claude_unavailable");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done) break;
      const { frames, rest } = splitSseFrames(buffer + decoder.decode(chunk.value, { stream: true }));
      buffer = rest;
      for (const raw of frames) {
        const e = parseFrame(raw);
        if (e) onEvent(e);
      }
    }
    onEnd();
  })();
  return () => abort.abort();
}

/**
 * «Chiedi a Claude»: il testo fin lì in `onText`; alla fine il testo intero e
 * le task che cita. «Ferma» tiene il testo fin lì (`complete: false`). Uno
 * stream che finisce senza la sua fine (caduto, Claude non disponibile) è
 * `claude_unavailable`.
 */
const streamClaudeDraft: Mail["streamClaudeDraft"] = (request, onText) => {
  let text = "";
  let settled = false;
  let close: () => void = () => undefined;
  let stopNow: () => void = () => undefined;
  const result = new Promise<Outcome>((resolve, reject) => {
    const finish = (outcome: Outcome | Error) => {
      if (settled) return;
      settled = true;
      close();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    stopNow = () => finish({ text, projectId: null, used: [], complete: false });
    const onEvent = (e: DraftEvent) => {
      if (settled) return;
      if (e.type === "delta") {
        text += e.text;
        onText(text);
      } else if (e.type === "done") {
        finish({ text: e.text, projectId: e.projectId, used: usedOf(e.used), complete: true });
      } else finish(errorOf(e.code));
    };
    const onEnd = (code?: string) => finish(errorOf(code));
    void (async () => {
      const { firstConnected } = await myMailboxes();
      const { accountId, thread } = placeOf(request.threadId, firstConnected);
      if (settled) return;
      const body = {
        accountId,
        threadId: thread,
        mode: thread === null ? "new" : "reply",
        hint: request.hint ?? "",
        projectId: request.projectId ?? null,
      };
      const bridge = window.stubwise?.openStream;
      close = bridge
        ? bridge(
            PATH,
            (m) => {
              if (m.type === "mailDraft") onEvent(m.event as DraftEvent);
              else if (m.type === "end") onEnd(m.code);
            },
            { body },
          )
        : openFromBrowser(body, onEvent, onEnd);
    })().catch((error: unknown) => finish(error instanceof Error ? error : new Error("claude_unavailable")));
  });
  return { result, stop: () => stopNow() };
};

export const mailClaudeDraftFunctions: Partial<Mail> = { streamClaudeDraft };
