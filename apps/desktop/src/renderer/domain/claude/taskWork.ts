import type {
  ConversationEvent,
  Outcome,
  PullRequestEvent,
  TaskRun,
  TaskWork,
} from "../../data/types";

// Il lavoro di Claude su una task letto dalle sue sessioni: lo stato
// dell'ultima, le PR, la correzione in corso e la storia del lavoro. Puro.
// Come `buildTicketHistory` di oggi afferma solo ciò che i dati dimostrano:
// un evento c'è se c'è nel flusso (o fra gli eventi della piattaforma), e il
// testo dei risultati è quello che il flusso porta, mai riscritto.

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;

/** Lo stato del lavoro, dall'ultima sessione. `at`: da quando è così. */
export type WorkStatus =
  | { kind: "none" }
  | { kind: "working"; action: string | null; at: string }
  | { kind: "awaiting_answer"; at: string }
  | { kind: "awaiting_approval"; at: string }
  | { kind: "paused"; phase: string | null; byId: string | null; at: string }
  | { kind: "done"; at: string }
  | { kind: "ended"; outcome: Exclude<Outcome, "ok">; phase: string | null; byId: string | null; at: string };

const lastOf = <T extends ConversationEvent["type"]>(
  events: readonly ConversationEvent[],
  type: T,
  where: (e: Ev<T>) => boolean = () => true,
): Ev<T> | undefined => {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.type === type && where(e as Ev<T>)) return e as Ev<T>;
  }
  return undefined;
};

/** La fase in cui la sessione è (l'ultima aperta o chiusa). */
export function phaseOf(events: readonly ConversationEvent[]): string | null {
  return lastOf(events, "phase")?.phase ?? null;
}

export function statusOf(run: TaskRun | undefined, events = run?.events ?? []): WorkStatus {
  if (!run) return { kind: "none" };
  const lastAt = events.at(-1)?.at ?? run.createdAt;
  switch (run.state) {
    case "working":
    case "idle": {
      const action = lastOf(events, "action", (e) => e.state === "running");
      return { kind: "working", action: action?.label ?? null, at: action?.at ?? lastAt };
    }
    case "awaiting_answer": {
      const q = lastOf(events, "question", (e) => e.answer === null);
      return { kind: "awaiting_answer", at: q?.at ?? lastAt };
    }
    case "awaiting_approval": {
      const p = lastOf(events, "plan", (e) => e.status === "pending");
      return { kind: "awaiting_approval", at: p?.at ?? lastAt };
    }
    case "paused": {
      const stop = lastOf(events, "phase", (e) => e.outcome === "stopped");
      return {
        kind: "paused",
        phase: phaseOf(events),
        byId: stop?.stoppedById ?? null,
        at: stop?.at ?? lastAt,
      };
    }
    case "finished": {
      if (run.outcome === "ok" || run.outcome === null) return { kind: "done", at: lastAt };
      const end = lastOf(events, "phase", (e) => e.outcome === run.outcome);
      return {
        kind: "ended",
        outcome: run.outcome,
        phase: end?.phase ?? phaseOf(events),
        byId: end?.stoppedById ?? null,
        at: end?.at ?? lastAt,
      };
    }
  }
}

/** L'ultima cosa che Claude ha scritto nella sessione (anche mentre arriva). */
export function lastMessage(events: readonly ConversationEvent[]): Ev<"assistant"> | null {
  return lastOf(events, "assistant", (e) => e.text.trim().length > 0) ?? null;
}

/**
 * La domanda o il piano che aspettano nella sessione (al più uno: la
 * sessione si ferma su uno alla volta).
 */
export function openCard(events: readonly ConversationEvent[]): Ev<"question"> | Ev<"plan"> | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.type === "question" && e.answer === null) return e;
    if (e.type === "plan" && e.status === "pending") return e;
  }
  return null;
}

/** La sessione è ferma nella correzione: «Resume correction» la fa ripartire. */
export function correctionHeld(run: TaskRun | undefined, events = run?.events ?? []): boolean {
  return run?.state === "paused" && phaseOf(events) === "correction";
}

// --- PR ----------------------------------------------------------------------

export interface PrLine {
  /** Il numero sulla piattaforma, se il flusso o la piattaforma lo dicono. */
  number: number | null;
  /** `owner/repo`, letto dal link della PR quando c'è. */
  repo: string | null;
  link: string | null;
  /** Il testo del flusso quando la PR non ha un numero («Pull request opened for STW-4»). */
  text: string;
  state: "open" | "merged" | "closed";
  /** Quando è stata mergiata o chiusa (dalla piattaforma). */
  closedAt: string | null;
}

const PR_NUMBER = /#(\d+)/;
const PR_LINK = /\/([^/]+\/[^/]+)\/pull\/\d+/;

function numberIn(text: string): number | null {
  const m = PR_NUMBER.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * Le PR della task, dalla più vecchia: quelle aperte da Claude (dal flusso)
 * e quelle che la piattaforma conosce, una riga per PR, con lo stato
 * dell'ultimo evento della piattaforma.
 */
export function pullRequestsOf(work: TaskWork, latest?: readonly ConversationEvent[]): PrLine[] {
  const lines: PrLine[] = [];
  const byNumber = new Map<number, PrLine>();
  const opened = runsEvents(work, latest).flatMap((e) =>
    e.type === "work_result" && e.kind === "pr_opened" ? [e] : [],
  );
  for (const e of opened) {
    const number = numberIn(e.text);
    if (number !== null && byNumber.has(number)) continue;
    const line: PrLine = {
      number,
      repo: e.link ? (PR_LINK.exec(e.link)?.[1] ?? null) : null,
      link: e.link ?? null,
      text: e.text,
      state: "open",
      closedAt: null,
    };
    lines.push(line);
    if (number !== null) byNumber.set(number, line);
  }
  for (const pr of work.pullRequests) {
    let line = byNumber.get(pr.number);
    if (!line) {
      line = { number: pr.number, repo: null, link: null, text: "", state: "open", closedAt: null };
      lines.push(line);
      byNumber.set(pr.number, line);
    }
    applyPlatform(line, pr);
  }
  return lines;
}

function applyPlatform(line: PrLine, pr: PullRequestEvent): void {
  if (pr.kind === "pr_opened") {
    line.state = "open";
    line.closedAt = null;
  } else {
    line.state = pr.kind === "pr_merged" ? "merged" : "closed";
    line.closedAt = pr.at;
  }
}

/** L'ultimo esito di review che il flusso riporta (il testo così com'è). */
export function lastReview(work: TaskWork, latest?: readonly ConversationEvent[]): string | null {
  return (
    runsEvents(work, latest)
      .filter((e): e is Ev<"work_result"> => e.type === "work_result" && e.kind === "review")
      .at(-1)?.text ?? null
  );
}

/** I flussi di tutte le sessioni, in ordine; quello dell'ultima può arrivare dal vivo. */
function runsEvents(work: TaskWork, latest?: readonly ConversationEvent[]): ConversationEvent[] {
  return work.runs.flatMap((run, i) =>
    i === work.runs.length - 1 && latest && latest.length > 0 ? latest : run.events,
  );
}

// --- storia del lavoro -----------------------------------------------------------

export type StoryEntry =
  | { kind: "run_started"; key: string; at: string; byId: string }
  | { kind: "correction_requested"; key: string; at: string; byId: string; ordinal: number }
  | { kind: "correction_started"; key: string; at: string; ordinal: number }
  | { kind: "correction_resumed"; key: string; at: string; ordinal: number }
  | {
      kind: "plan";
      key: string;
      at: string;
      status: Ev<"plan">["status"];
      decidedById: string | null;
      instructions: string | null;
    }
  | { kind: "question"; key: string; at: string; text: string }
  | { kind: "answer"; key: string; at: string; byId: string; label: string }
  | {
      kind: "result";
      key: string;
      at: string;
      result: Ev<"work_result">["kind"];
      text: string;
      link: string | null;
    }
  | { kind: "pr"; key: string; at: string; event: PullRequestEvent["kind"]; number: number }
  | {
      kind: "ended";
      key: string;
      at: string;
      outcome: Exclude<Outcome, "ok">;
      phase: string;
      byId: string | null;
    };

/**
 * La storia del lavoro di Claude sulla task, dalla più vecchia. Per
 * sessione: l'avvio (o la correzione chiesta, se la sessione nasce da
 * «Request changes») con chi l'ha chiesto, i piani con la loro decisione, le
 * domande e le risposte, i risultati con il loro testo, gli arresti e i
 * fallimenti; poi merge e chiusure delle PR dalla piattaforma. Le
 * correzioni sono numerate sulla task, nell'ordine in cui cominciano; una
 * correzione ripresa dopo una pausa resta la stessa.
 */
export function workStory(work: TaskWork, latest?: readonly ConversationEvent[]): StoryEntry[] {
  const out: StoryEntry[] = [];
  let corrections = 0;
  const openedPrs = new Set<number>();

  work.runs.forEach((run, runIndex) => {
    const events =
      runIndex === work.runs.length - 1 && latest && latest.length > 0 ? latest : run.events;
    const first = events.find((e) => e.type === "phase");
    if (first?.phase === "correction") {
      corrections += 1;
      out.push({
        kind: "correction_requested",
        key: `${run.id}:start`,
        at: run.createdAt,
        byId: run.ownerId,
        ordinal: corrections,
      });
    } else {
      out.push({ kind: "run_started", key: `${run.id}:start`, at: run.createdAt, byId: run.ownerId });
    }
    // La fase di correzione aperta (o fermata) in questa sessione.
    let correctionOpen = first?.phase === "correction";
    let correctionStopped = false;

    for (const e of events) {
      switch (e.type) {
        case "phase": {
          if (e.phase === "correction" && e !== first) {
            const opens = e.outcome === null || !correctionOpen;
            if (opens && correctionStopped) {
              out.push({ kind: "correction_resumed", key: e.id, at: e.at, ordinal: corrections });
            } else if (opens) {
              corrections += 1;
              out.push({ kind: "correction_started", key: e.id, at: e.at, ordinal: corrections });
            }
            correctionOpen = e.outcome === null;
            correctionStopped = e.outcome === "stopped";
          } else if (e.phase === "correction") {
            correctionOpen = e.outcome === null;
            correctionStopped = e.outcome === "stopped";
          }
          if (e.outcome !== null && e.outcome !== "ok") {
            out.push({
              kind: "ended",
              key: e.id,
              at: e.at,
              outcome: e.outcome,
              phase: e.phase,
              byId: e.stoppedById ?? null,
            });
          }
          break;
        }
        case "plan":
          out.push({
            kind: "plan",
            key: e.id,
            at: e.at,
            status: e.status,
            decidedById: e.decidedById ?? null,
            instructions: e.instructions ?? null,
          });
          break;
        case "question":
          out.push({ kind: "question", key: e.id, at: e.at, text: e.text });
          if (e.answer) {
            const label =
              e.answer.optionIndex !== null
                ? (e.options[e.answer.optionIndex]?.label ?? "")
                : (e.answer.text ?? "");
            out.push({
              kind: "answer",
              key: `${e.id}:answer`,
              at: e.answer.at,
              byId: e.answer.byId,
              label,
            });
          }
          break;
        case "work_result": {
          if (e.kind === "pr_opened") {
            const n = numberIn(e.text);
            if (n !== null) openedPrs.add(n);
          }
          out.push({
            kind: "result",
            key: e.id,
            at: e.at,
            result: e.kind,
            text: e.text,
            link: e.link ?? null,
          });
          break;
        }
        default:
          break;
      }
    }
  });

  for (const pr of work.pullRequests) {
    // Un'apertura che il flusso ha già raccontato non si ripete.
    if (pr.kind === "pr_opened" && openedPrs.has(pr.number)) continue;
    out.push({ kind: "pr", key: pr.id, at: pr.at, event: pr.kind, number: pr.number });
  }

  // Stabile: a parità di istante resta l'ordine del flusso.
  return out
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => a.entry.at.localeCompare(b.entry.at) || a.i - b.i)
    .map(({ entry }) => entry);
}

/** La correzione più recente della task, come la mostra la riga «Correction N». */
export type CorrectionLine = {
  ordinal: number;
  state: "running" | "paused" | "pushed" | "ended";
  at: string;
};

export function latestCorrection(
  work: TaskWork,
  latest?: readonly ConversationEvent[],
): CorrectionLine | null {
  let ordinal = 0;
  let state: CorrectionLine["state"] = "running";
  let at = "";
  for (const entry of workStory(work, latest)) {
    if (
      entry.kind === "correction_requested" ||
      entry.kind === "correction_started" ||
      entry.kind === "correction_resumed"
    ) {
      ordinal = entry.ordinal;
      state = "running";
      at = entry.at;
    } else if (ordinal > 0 && entry.kind === "result" && entry.result === "correction") {
      state = "pushed";
      at = entry.at;
    } else if (ordinal > 0 && entry.kind === "ended" && entry.phase === "correction") {
      state = entry.outcome === "stopped" ? "paused" : "ended";
      at = entry.at;
    }
  }
  if (ordinal === 0) return null;
  // Una correzione fermata in una sessione già chiusa non è in pausa: è finita lì.
  if (state === "paused" && work.runs.at(-1)?.state === "finished") state = "ended";
  return { ordinal, state, at };
}
