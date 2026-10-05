import { prNumberFromUrl, type TicketHistory, type TicketHistoryEvent } from "@stubwise/shared";

/**
 * STORIA DEL TICKET — righe già lette → eventi ordinati, dal più recente.
 *
 * Modulo PURO (nessun I/O): le query stanno nel server
 * (`apps/server/src/services/ticket-history.ts`), che oggi è l'unico
 * consumatore. Sta qui, accanto a `project-timeline.ts`, perché la REGOLA —
 * quali righe diventano quale evento, come si numera una correzione — è la
 * parte che un domani il brief o il worker vorranno, e due copie della regola
 * divergerebbero. Design e piano: `docs/plans/2026-10-05-ticket-history-and-replies*.md`.
 *
 * Cosa entra, e da dove:
 *
 * | kind | sorgente |
 * |---|---|
 * | `run_started` | `ai_jobs` SENZA `correction_id` e PARTITI (`started_at` valorizzato), alla data dell'ultimo avvio |
 * | `question_asked` / `question_answered` | `agent_questions` |
 * | `plan_approved` / `plan_rejected` | `project_decisions` `plan_review` del ticket: `mode: execute` o `digest` (pre-approvazione, `detail: pre_approved`) / `mode: fix` |
 * | `pr_opened` | `ai_jobs` SENZA `correction_id` con PR e stato `pr_opened`/`pr_merged`/`pr_closed` |
 * | `review_completed` | `pr_reviews` `completed` e PARTITE (`started_at` valorizzato) |
 * | `changes_requested` | `pr_corrections`, anche `pending` e `cancelled` |
 * | `correction_pushed` / `correction_failed` | `ai_jobs` CON `correction_id`: `pr_*` / `failed` (una `skipped` non è un evento) |
 * | `ticket_closed` | `ticket_events.status_changed` verso `done` o `closed` |
 * | `status_changed` | ogni altro `ticket_events.status_changed` |
 *
 * **La chiusura ha un kind suo** (`ticket_closed`, `detail` = `done`/`closed`)
 * perché si legga da sola come chiusura e non come un cambio di stato
 * generico: la regola «done e closed sono chiusure» sta qui, una volta, e i
 * client mettono solo in parole. Non porta `fromStatus`: non serve a dirla, e
 * per le chiusure ricostruite dal backfill della fase 5
 * (`backfill-ticket-done-events.ts`) lo stato di partenza è PRESUNTO.
 *
 * **`in_review → triaged` NON si legge «PR chiusa senza merge».** Lo scrive il
 * webhook alla chiusura della PR, ma lo scrive identico — attore nullo, stessi
 * stati — anche il triage che parcheggia un rilancio su un ticket in revisione
 * (`apps/worker/src/pipeline/triage.ts`, ramo HOLD: `startRun` non guarda lo
 * stato del ticket). Il dato non distingue i due casi, quindi la storia dice
 * solo il cambio di stato (`fromStatus` + `detail`). Né `pr_merged`/`pr_closed`
 * hanno un evento: nessuna colonna ne porta la data.
 *
 * **`actor: null` = nessuna persona REGISTRATA**, non «automatico»: le colonne
 * d'autore sono `ON DELETE SET NULL`, e un utente eliminato è indistinguibile
 * da una transizione di sistema.
 *
 * **`round` è il numero d'ordine della correzione sulla SUA PR** — le non
 * `cancelled` di `(repositoryId, prNumber)` per `createdAt`, spareggio `id`, da
 * 1 — e NON `autoRoundsInCurrentSeries`/`cycle.round`, che conta i soli giri
 * AUTOMATICI dopo l'ultima richiesta umana e si azzera a ogni richiesta di una
 * persona. I due numeri rispondono a domande diverse: c'è un test di accordo
 * contro Postgres che fissa che NON coincidono (`ticket-history.cycle.test.ts`).
 * Una `cancelled` ha `round: null` e `detail: "cancelled"`. Il job di una
 * correzione ne eredita PR e `round`.
 *
 * **Ordine**: decrescente per `at`; a parità, `id` CRESCENTE (deterministico,
 * indipendente dall'ordine d'ingresso delle righe). `events` porta i primi
 * `limit`, `total` il numero prima del taglio.
 *
 * Limiti dichiarati (design §3): un rifiuto del piano SENZA istruzioni non ha
 * riga in `project_decisions` e resta fuori; un fix riciclato da `startRun` ha
 * UN solo `run_started` (l'ultimo avvio); di un ticket multi-repo solo la PR
 * primaria del job (`ai_jobs.pr_url`) ha `pr_opened`.
 */

/** Riga di `ai_jobs` del ticket. `requesterName` = email di chi l'ha avviato. */
export interface HistoryJobRow {
  id: string;
  status: string;
  correctionId: string | null;
  prUrl: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  requesterName: string | null;
}

/** Riga di `agent_questions` del ticket. */
export interface HistoryQuestionRow {
  id: string;
  askedAt: Date;
  answeredAt: Date | null;
  answeredByName: string | null;
}

/** Riga di `project_decisions` con `source = 'plan_review'` del ticket. */
export interface HistoryDecisionRow {
  id: string;
  sourceRef: Record<string, unknown> | null;
  decidedAt: Date;
  decidedByName: string | null;
}

/** Riga di `pr_reviews` del ticket (il filtro su stato e avvio lo fa il modulo). */
export interface HistoryReviewRow {
  id: string;
  repositoryId: string;
  prNumber: number;
  prUrl: string;
  verdict: string | null;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** Riga di `pr_corrections` del ticket, con l'email del richiedente se c'è. */
export interface HistoryCorrectionRow {
  id: string;
  repositoryId: string;
  prNumber: number;
  trigger: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  userEmail: string | null;
  providerLogin: string | null;
}

/** Riga di `ticket_events` `status_changed`, col payload già letto. */
export interface HistoryStatusEventRow {
  id: string;
  from: string | null;
  to: string | null;
  actorName: string | null;
  createdAt: Date;
}

/** L'URL di ogni PR del ticket, da `ticket_repositories`. */
export interface HistoryPrUrlRow {
  repositoryId: string;
  prNumber: number;
  prUrl: string;
}

export interface TicketHistoryRows {
  jobs: HistoryJobRow[];
  questions: HistoryQuestionRow[];
  decisions: HistoryDecisionRow[];
  reviews: HistoryReviewRow[];
  corrections: HistoryCorrectionRow[];
  statusEvents: HistoryStatusEventRow[];
  prUrls: HistoryPrUrlRow[];
}

/** Gli stati di un job che ha pushato (la PR c'è): il merge/chiusura li sposta tutti insieme. */
const PUSHED_JOB_STATUSES = new Set(["pr_opened", "pr_merged", "pr_closed"]);
/** Gli stati di arrivo che chiudono un ticket. */
const CLOSING_STATUSES = new Set(["done", "closed"]);

type Actor = TicketHistoryEvent["actor"];
const AI: Actor = { type: "ai", name: null };
const user = (name: string | null): Actor => (name === null ? null : { type: "user", name });

interface Draft {
  kind: string;
  rowId: string;
  at: Date;
  actor: Actor;
  prNumber?: number | null;
  prUrl?: string | null;
  round?: number | null;
  detail?: string | null;
  fromStatus?: string | null;
}

const prKey = (repositoryId: string, prNumber: number) => `${repositoryId}#${prNumber}`;

function correctionActor(c: HistoryCorrectionRow): Actor {
  if (c.trigger === "review") return AI;
  // Stessa regola del nome di `lastRequest` (`derivePrCycle`): dalla
  // piattaforma il login, da Stubwise l'email, ciascuno con l'altro come ripiego.
  if (c.trigger === "provider") return { type: "provider", name: c.providerLogin ?? c.userEmail };
  return { type: "user", name: c.userEmail ?? c.providerLogin };
}

/** Il numero d'ordine di ogni correzione non `cancelled` sulla sua PR, da 1. */
function correctionRounds(corrections: HistoryCorrectionRow[]): Map<string, number> {
  const byPr = new Map<string, HistoryCorrectionRow[]>();
  for (const c of corrections) {
    if (c.status === "cancelled") continue;
    const key = prKey(c.repositoryId, c.prNumber);
    const list = byPr.get(key) ?? [];
    list.push(c);
    byPr.set(key, list);
  }
  const rounds = new Map<string, number>();
  for (const list of byPr.values()) {
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || cmp(a.id, b.id));
    list.forEach((c, i) => rounds.set(c.id, i + 1));
  }
  return rounds;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function planDecisionKind(
  ref: Record<string, unknown> | null,
): { kind: string; detail: string | null } | null {
  if (ref === null) return null;
  if (typeof ref.digest === "string") return { kind: "plan_approved", detail: "pre_approved" };
  if (ref.mode === "execute") return { kind: "plan_approved", detail: null };
  if (ref.mode === "fix") return { kind: "plan_rejected", detail: null };
  return null;
}

export function buildTicketHistory(
  rows: TicketHistoryRows,
  opts: { limit: number },
): TicketHistory {
  const drafts: Draft[] = [];
  const urls = new Map(rows.prUrls.map((r) => [prKey(r.repositoryId, r.prNumber), r.prUrl]));
  const rounds = correctionRounds(rows.corrections);
  const correctionsById = new Map(rows.corrections.map((c) => [c.id, c]));

  for (const j of rows.jobs) {
    if (j.correctionId === null) {
      // Solo un job PARTITO: `startRun`/`resolvePlan` riciclano la riga
      // azzerando `started_at` ma non `created_at`, quindi un ripiego sulla
      // creazione metterebbe un «run avviato» datato settimane fa, o su un
      // job `skipped` mai partito. Un job in coda non è ancora un avvio: lo
      // dice la testata del ticket, non la storia.
      if (j.startedAt !== null) {
        drafts.push({
          kind: "run_started",
          rowId: j.id,
          at: j.startedAt,
          actor: user(j.requesterName),
        });
      }
      if (j.prUrl !== null && PUSHED_JOB_STATUSES.has(j.status)) {
        drafts.push({
          kind: "pr_opened",
          rowId: j.id,
          at: j.finishedAt ?? j.startedAt ?? j.createdAt,
          actor: AI,
          prNumber: prNumberFromUrl(j.prUrl),
          prUrl: j.prUrl,
        });
      }
      continue;
    }
    const kind = PUSHED_JOB_STATUSES.has(j.status)
      ? "correction_pushed"
      : j.status === "failed"
        ? "correction_failed"
        : null;
    if (kind === null) continue;
    const c = correctionsById.get(j.correctionId);
    drafts.push({
      kind,
      rowId: j.id,
      at: j.finishedAt ?? j.startedAt ?? j.createdAt,
      actor: AI,
      prNumber: c?.prNumber ?? null,
      prUrl: c ? (urls.get(prKey(c.repositoryId, c.prNumber)) ?? null) : null,
      round: c ? (rounds.get(c.id) ?? null) : null,
    });
  }

  for (const q of rows.questions) {
    drafts.push({ kind: "question_asked", rowId: q.id, at: q.askedAt, actor: AI });
    if (q.answeredAt !== null) {
      drafts.push({
        kind: "question_answered",
        rowId: q.id,
        at: q.answeredAt,
        actor: user(q.answeredByName),
      });
    }
  }

  for (const d of rows.decisions) {
    const plan = planDecisionKind(d.sourceRef);
    if (plan === null) continue;
    drafts.push({
      kind: plan.kind,
      rowId: d.id,
      at: d.decidedAt,
      actor: user(d.decidedByName),
      detail: plan.detail,
    });
  }

  for (const r of rows.reviews) {
    if (r.status !== "completed" || r.startedAt === null) continue;
    drafts.push({
      kind: "review_completed",
      rowId: r.id,
      at: r.finishedAt ?? r.createdAt,
      actor: AI,
      prNumber: r.prNumber,
      prUrl: r.prUrl,
      detail: r.verdict,
    });
  }

  for (const c of rows.corrections) {
    const cancelled = c.status === "cancelled";
    drafts.push({
      kind: "changes_requested",
      rowId: c.id,
      // L'ora della RICHIESTA, come `lastRequest`: una `pending` si rinnova
      // quando una richiesta nuova vi si fonde.
      at: c.status === "pending" ? c.updatedAt : c.createdAt,
      actor: correctionActor(c),
      prNumber: c.prNumber,
      prUrl: urls.get(prKey(c.repositoryId, c.prNumber)) ?? null,
      round: cancelled ? null : (rounds.get(c.id) ?? null),
      detail: cancelled ? "cancelled" : null,
    });
  }

  for (const e of rows.statusEvents) {
    if (e.to === null) continue;
    const closing = CLOSING_STATUSES.has(e.to);
    drafts.push({
      kind: closing ? "ticket_closed" : "status_changed",
      rowId: e.id,
      at: e.createdAt,
      actor: user(e.actorName),
      detail: e.to,
      fromStatus: closing ? null : e.from,
    });
  }

  const events: TicketHistoryEvent[] = drafts
    .map((d) => ({
      id: `${d.kind}:${d.rowId}`,
      kind: d.kind,
      at: d.at.toISOString(),
      actor: d.actor,
      prNumber: d.prNumber ?? null,
      prUrl: d.prUrl ?? null,
      round: d.round ?? null,
      detail: d.detail ?? null,
      fromStatus: d.fromStatus ?? null,
    }))
    .sort((a, b) => cmp(b.at, a.at) || cmp(a.id, b.id));

  return { events: events.slice(0, opts.limit), total: events.length };
}
