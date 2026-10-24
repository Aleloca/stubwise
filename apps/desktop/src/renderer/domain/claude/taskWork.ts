import type {
  ConversationEvent,
  Outcome,
  PrRef,
  PullRequestEvent,
  RunProvider,
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
  | { kind: "idle"; at: string }
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
    case "idle":
      // Né al lavoro né fermo: aspetta il seguito (niente anello che pulsa).
      return { kind: "idle", at: lastAt };
    case "working": {
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
  /** `repo#numero` (una task può avere PR su più repository); senza numero, l'id dell'evento. */
  key: string;
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
/** La chiave di una PR: `repo#numero` (il repository può non saperlo il flusso: ""). */
export function prKey(repo: string | null, number: number): string {
  return `${repo ?? ""}#${number}`;
}

/**
 * Le PR della task, dalla più vecchia: quelle aperte da Claude (dal flusso)
 * e quelle che la piattaforma conosce, una riga per PR (`repo#numero`), con
 * lo stato dell'ultimo evento della piattaforma. Una PR del flusso senza
 * link (repository ignoto) si aggancia a quella della piattaforma con lo
 * stesso numero.
 */
export function pullRequestsOf(work: TaskWork, latest?: readonly ConversationEvent[]): PrLine[] {
  const lines: PrLine[] = [];
  const opened = runsEvents(work, latest).flatMap((e) =>
    e.type === "work_result" && e.kind === "pr_opened" ? [e] : [],
  );
  for (const e of opened) {
    const number = numberIn(e.text);
    const repo = e.link ? (PR_LINK.exec(e.link)?.[1] ?? null) : null;
    const key = number !== null ? prKey(repo, number) : `event:${e.id}`;
    if (lines.some((l) => l.key === key)) continue;
    lines.push({ key, number, repo, link: e.link ?? null, text: e.text, state: "open", closedAt: null });
  }
  for (const pr of work.pullRequests) {
    let line =
      lines.find((l) => l.number === pr.number && l.repo === pr.repo) ??
      lines.find((l) => l.number === pr.number && l.repo === null);
    if (!line) {
      line = {
        key: prKey(pr.repo, pr.number),
        number: pr.number,
        repo: pr.repo,
        link: null,
        text: "",
        state: "open",
        closedAt: null,
      };
      lines.push(line);
    }
    applyPlatform(line, pr);
  }
  return lines;
}

function applyPlatform(line: PrLine, pr: PullRequestEvent): void {
  if (line.repo === null) {
    line.repo = pr.repo;
    line.key = prKey(pr.repo, pr.number);
  }
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
  /** `provider`: l'account o la chiave con cui la sessione ha girato (il nome). */
  | { kind: "run_started"; key: string; at: string; byId: string; provider: RunProvider | null }
  /** `ordinal` per PR; `null` per una correzione fermata (annullata), che non prende numero. */
  | { kind: "correction_requested"; key: string; at: string; byId: string; ordinal: number | null }
  | { kind: "correction_started"; key: string; at: string; ordinal: number | null }
  | { kind: "correction_resumed"; key: string; at: string; ordinal: number | null }
  /**
   * Il piano scritto, all'ora in cui è arrivato. Se il registro ha la riga
   * della decisione, questa è a parte (`plan_decision`, con la sua data) e
   * qui `folded` è falso; senza riga la decisione sta nella stessa voce,
   * senza un'ora che Stubwise non conosce. Approvato in anticipo: arriva già
   * approvato, una voce sola.
   */
  | {
      kind: "plan";
      key: string;
      at: string;
      status: Ev<"plan">["status"];
      decidedById: string | null;
      instructions: string | null;
      folded: boolean;
    }
  | {
      kind: "plan_decision";
      key: string;
      at: string;
      status: "approved" | "rejected";
      byId: string | null;
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

type CorrectionEntry = Extract<
  StoryEntry,
  { kind: "correction_requested" | "correction_started" | "correction_resumed" }
>;

/**
 * Una correzione, come il ciclo di una PR la legge: quando comincia, su
 * quale PR (`repo#numero`), a che punto è, se è stata annullata (fermata e
 * chiusa). `ordinal`: il giro sulla sua PR, `null` se annullata.
 */
export interface CorrectionRecord {
  at: string;
  pr: string | null;
  cancelled: boolean;
  /** `done`: finita senza un invio (niente da spingere). */
  state: "running" | "paused" | "pushed" | "failed" | "done";
  /** Da quando è in quello stato. */
  stateAt: string;
  ordinal: number | null;
}

/**
 * Le aperture delle PR (flusso e piattaforma), in ordine, con la chiave
 * `repo#numero` (o l'evento): la PR di una correzione che non la dice.
 */
function prOpenings(work: TaskWork, latest?: readonly ConversationEvent[]) {
  const out: { at: string; key: string }[] = [];
  for (const e of runsEvents(work, latest)) {
    if (e.type !== "work_result" || e.kind !== "pr_opened") continue;
    const n = numberIn(e.text);
    const repo = e.link ? (PR_LINK.exec(e.link)?.[1] ?? null) : null;
    out.push({ at: e.at, key: n !== null ? prKey(repo, n) : `event:${e.id}` });
  }
  for (const pr of work.pullRequests) {
    if (pr.kind === "pr_opened") out.push({ at: pr.at, key: prKey(pr.repo, pr.number) });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * La storia del lavoro di Claude sulla task, dalla più vecchia. Per
 * sessione: l'avvio (o la correzione chiesta, se la sessione nasce da
 * «Request changes») con chi l'ha chiesto, i piani e le loro decisioni, le
 * domande e le risposte, i risultati con il loro testo, gli arresti e i
 * fallimenti; poi merge e chiusure delle PR dalla piattaforma.
 *
 * Le correzioni sono numerate PER PR (come la storia del ticket di oggi):
 * la PR di una correzione è quella che la sua fase dice (il job la conosce),
 * altrimenti l'ultima aperta prima che cominci; contano quelle non
 * annullate, nell'ordine in cui cominciano. Una correzione ripresa dopo una
 * pausa resta la stessa; una fermata in una sessione poi chiusa è annullata
 * e non prende numero.
 */
export function workStory(work: TaskWork, latest?: readonly ConversationEvent[]): StoryEntry[] {
  return analyze(work, latest).story;
}

/** Le correzioni della task, dalla più vecchia, con la loro PR, il giro e lo stato. */
export function correctionsOf(
  work: TaskWork,
  latest?: readonly ConversationEvent[],
): CorrectionRecord[] {
  return analyze(work, latest).records;
}

function analyze(
  work: TaskWork,
  latest?: readonly ConversationEvent[],
): { story: StoryEntry[]; records: CorrectionRecord[] } {
  const out: StoryEntry[] = [];
  const openedPrs = new Set<string>();
  const openings = prOpenings(work, latest);
  const prAt = (at: string) => openings.filter((o) => o.at <= at).at(-1)?.key ?? null;
  const records: CorrectionRecord[] = [];
  const recordOf = new Map<CorrectionEntry, CorrectionRecord>();
  const usedDecisions = new Set<number>();
  const newRecord = (at: string, pr: PrRef | undefined) => {
    const record: CorrectionRecord = {
      at,
      pr: pr ? prKey(pr.repo, pr.number) : prAt(at),
      cancelled: false,
      state: "running",
      stateAt: at,
      ordinal: null,
    };
    records.push(record);
    return record;
  };

  work.runs.forEach((run, runIndex) => {
    const events =
      runIndex === work.runs.length - 1 && latest && latest.length > 0 ? latest : run.events;
    const first = events.find((e) => e.type === "phase");
    // La correzione di questa sessione e se la sua ultima fase si è fermata.
    let current: CorrectionRecord | null = null;
    let stopped = false;
    if (first?.phase === "correction") {
      current = newRecord(run.createdAt, first.pr);
      const entry: CorrectionEntry = {
        kind: "correction_requested",
        key: `${run.id}:start`,
        at: run.createdAt,
        byId: run.ownerId,
        ordinal: null,
      };
      recordOf.set(entry, current);
      out.push(entry);
    } else {
      out.push({
        kind: "run_started",
        key: `${run.id}:start`,
        at: run.createdAt,
        byId: run.ownerId,
        provider: run.provider ?? null,
      });
    }
    let correctionOpen = first?.phase === "correction";

    for (const e of events) {
      switch (e.type) {
        case "phase": {
          if (e.phase === "correction" && e !== first) {
            const opens = e.outcome === null || !correctionOpen;
            if (opens && current && stopped) {
              const entry: CorrectionEntry = {
                kind: "correction_resumed",
                key: e.id,
                at: e.at,
                ordinal: null,
              };
              recordOf.set(entry, current);
              current.state = "running";
              current.stateAt = e.at;
              out.push(entry);
            } else if (opens) {
              current = newRecord(e.at, e.pr);
              const entry: CorrectionEntry = {
                kind: "correction_started",
                key: e.id,
                at: e.at,
                ordinal: null,
              };
              recordOf.set(entry, current);
              out.push(entry);
            }
          }
          if (e.phase === "correction") {
            correctionOpen = e.outcome === null;
            stopped = e.outcome === "stopped";
            if (current && e.outcome !== null) {
              if (e.outcome === "stopped") current.state = "paused";
              else if (e.outcome !== "ok") current.state = "failed";
              else if (current.state === "running") current.state = "done";
              if (current.state !== "pushed") current.stateAt = e.at;
            }
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
        case "plan": {
          const decided = e.status === "approved" || e.status === "rejected";
          const index = decided
            ? work.planDecisions.findIndex(
                (d, i) =>
                  !usedDecisions.has(i) &&
                  d.decidedAt >= e.at &&
                  d.decidedById === (e.decidedById ?? null) &&
                  (e.status === "rejected") === /\brejected\b/i.test(d.decision),
              )
            : -1;
          out.push({
            kind: "plan",
            key: e.id,
            at: e.at,
            status: e.status,
            decidedById: e.decidedById ?? null,
            instructions: e.instructions ?? null,
            folded: decided && index < 0,
          });
          if (index >= 0) {
            usedDecisions.add(index);
            out.push({
              kind: "plan_decision",
              key: `${e.id}:decision`,
              at: work.planDecisions[index]!.decidedAt,
              status: e.status as "approved" | "rejected",
              byId: e.decidedById ?? null,
              instructions: e.instructions ?? null,
            });
          }
          break;
        }
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
            const repo = e.link ? (PR_LINK.exec(e.link)?.[1] ?? null) : null;
            if (n !== null) openedPrs.add(prKey(repo, n));
          }
          // L'invio di una correzione: quella in corso in questa sessione.
          if (e.kind === "correction" && current && current.state === "running") {
            current.state = "pushed";
            current.stateAt = e.at;
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
    // Fermata e mai ripresa in una sessione chiusa: la correzione è annullata.
    if (current && stopped && run.state === "finished") current.cancelled = true;
  });

  // I numeri, per PR, sulle correzioni non annullate in ordine d'inizio.
  const ordinals = new Map<CorrectionRecord, number>();
  const perPr = new Map<string | null, number>();
  for (const record of [...records].sort((a, b) => a.at.localeCompare(b.at))) {
    if (record.cancelled) continue;
    const n = (perPr.get(record.pr) ?? 0) + 1;
    perPr.set(record.pr, n);
    ordinals.set(record, n);
  }
  for (const [entry, record] of recordOf) entry.ordinal = ordinals.get(record) ?? null;
  for (const record of records) record.ordinal = ordinals.get(record) ?? null;

  for (const pr of work.pullRequests) {
    // Un'apertura che il flusso ha già raccontato non si ripete (anche senza link).
    if (
      pr.kind === "pr_opened" &&
      (openedPrs.has(prKey(pr.repo, pr.number)) || openedPrs.has(prKey(null, pr.number)))
    ) {
      continue;
    }
    out.push({ kind: "pr", key: pr.id, at: pr.at, event: pr.kind, number: pr.number });
  }

  // Stabile: a parità di istante resta l'ordine del flusso.
  const story = out
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => a.entry.at.localeCompare(b.entry.at) || a.i - b.i)
    .map(({ entry }) => entry);
  return { story, records: [...records].sort((a, b) => a.at.localeCompare(b.at)) };
}

/**
 * Lo stato del ciclo review → correzione di una PR aperta, DERIVATO (come
 * `pr-cycle-row` del web legge quello del server): il giro dalle correzioni
 * della PR, il «dove siamo» dall'ultima correzione e dall'ultima review, il
 * tetto dal progetto. Dai fatti esterni solo ciò che Stubwise non produce:
 * la review, il branch protetto, la coda.
 */
export type PrCycle = {
  state:
    | "reviewing"
    | "idle"
    | "correcting"
    | "paused"
    | "approved"
    | "changes_requested"
    | "capped"
    | "correction_failed"
    | "queued";
  /** Il giro: le correzioni (non annullate) fatte o in corso su questa PR. */
  round: number;
  maxRounds: number;
  requestedById: string | null;
  requestedOn: "stubwise" | "platform" | null;
  branchProtected: boolean;
};

export function prCycles(
  work: TaskWork,
  lines: readonly PrLine[],
  latest?: readonly ConversationEvent[],
): Map<string, PrCycle> {
  const records = correctionsOf(work, latest);
  const out = new Map<string, PrCycle>();
  for (const line of lines) {
    if (line.state !== "open" || line.number === null) continue;
    const fact = work.prFacts.find((f) => f.number === line.number && f.repo === line.repo);
    const mine = records.filter((r) => r.pr === line.key && !r.cancelled);
    const last = mine.at(-1);
    const round = mine.length;
    const review = fact?.review ?? null;
    // La review conta solo se è arrivata dopo l'ultima correzione.
    const freshReview = review && (!last || review.at > last.stateAt) ? review : null;
    let state: PrCycle["state"];
    if (fact?.queued) state = "queued";
    else if (last?.state === "running") state = "correcting";
    else if (last?.state === "paused") state = "paused";
    else if (last?.state === "failed") state = "correction_failed";
    else if (freshReview?.verdict === "changes_requested") {
      state = round >= work.correctionCap ? "capped" : "changes_requested";
    } else if (freshReview?.verdict === "approved") state = "approved";
    else if (freshReview?.verdict === "pending" || last) state = "reviewing";
    else state = "idle";
    out.set(line.key, {
      state,
      round,
      maxRounds: work.correctionCap,
      requestedById: freshReview?.byId ?? null,
      requestedOn: freshReview?.on ?? null,
      branchProtected: fact?.branchProtected ?? false,
    });
  }
  return out;
}

/** La correzione più recente della task, come la mostra la riga «Correction N». */
export type CorrectionLine = {
  /** `null`: annullata (fermata), senza numero. */
  ordinal: number | null;
  state: "running" | "paused" | "pushed" | "ended";
  at: string;
};

export function latestCorrection(
  work: TaskWork,
  latest?: readonly ConversationEvent[],
): CorrectionLine | null {
  let seen = false;
  let ordinal: number | null = null;
  let state: CorrectionLine["state"] = "running";
  let at = "";
  for (const entry of workStory(work, latest)) {
    if (
      entry.kind === "correction_requested" ||
      entry.kind === "correction_started" ||
      entry.kind === "correction_resumed"
    ) {
      seen = true;
      ordinal = entry.ordinal;
      state = "running";
      at = entry.at;
    } else if (seen && entry.kind === "result" && entry.result === "correction") {
      state = "pushed";
      at = entry.at;
    } else if (seen && entry.kind === "ended" && entry.phase === "correction") {
      state = entry.outcome === "stopped" ? "paused" : "ended";
      at = entry.at;
    }
  }
  if (!seen) return null;
  // Una correzione fermata in una sessione già chiusa non è in pausa: è finita lì.
  if (state === "paused" && work.runs.at(-1)?.state === "finished") state = "ended";
  return { ordinal, state, at };
}
