import { sql } from "drizzle-orm";
import type { Db } from "@stubwise/db";

/**
 * «Clienti in attesa» (area 8; piano
 * docs/plans/2026-11-15-integrazione-area8-clienti-in-attesa-plan.md): il
 * TAGLIO meccanico, in UN posto, perché lo usano sia la rotta del server
 * (cosa si mostra) sia il giudizio del worker (J2: cosa si giudica). Due copie
 * di queste condizioni divergerebbero.
 *
 * Un thread di una casella è CANDIDATO quando:
 * - (a) ha almeno un messaggio AMMESSO, attribuito a un progetto
 *   (`project_id`, o il primo di `scope_project_ids` della classificazione
 *   nuova) — la visibilità del progetto la filtra chi legge;
 * - (b) l'ULTIMO messaggio (contesto compreso) non è della casella stessa;
 * - (c) l'ultimo messaggio ESTERNO (non da una casella dell'istanza) è più
 *   vecchio di `cutoff`;
 * - (d) nessun `mail_outgoing` `sent` della casella sul thread dopo l'ultimo
 *   messaggio;
 * - (e) non è rumore. Ruling di 72 (15 nov 2026), sui dati veri: la
 *   classificazione vecchia non scrive più `signal` sul messaggio (sta sulle
 *   proposte, fase 6b) e chiude il rumore come `ignored`; quella nuova scrive
 *   `importance`. Quindi l'ultimo messaggio ammesso NON è rumore se è ancora
 *   `new` o `failed` (non classificato: con le proposte spente resta `new`
 *   per sempre, e decide il giudizio, W-3 = a), se non è `ignored`, o se ha
 *   importanza `high`.
 *
 * Nessuna lettura di caselle altrui: la query prende SOLO gli `accountIds`
 * passati (le caselle di chi guarda, o quella che il worker giudica). Gli
 * altri indirizzi dell'istanza servono solo a dire «non esterno».
 */
export interface WaitingCandidate {
  accountId: string;
  accountEmail: string;
  threadId: string;
  /** L'ultimo messaggio del thread: il suo giudizio vale solo finché è l'ultimo. */
  lastMessageId: string;
  lastFromAddress: string;
  /** L'ultimo messaggio ESTERNO: «aspetta da». */
  waitingSince: Date;
  customerEmail: string;
  customerName: string | null;
  subject: string | null;
  projectId: string;
  importance: "high" | "normal" | "low" | null;
  replyJudgment: { needsMyReply?: boolean; reason?: string; error?: string } | null;
  replyJudgmentAttempts: number;
  /** Il segnale dell'ultima proposta del thread (v1 non lo scrive più sul messaggio). */
  signal: string | null;
}

export interface WaitingCandidatesInput {
  accountIds: readonly string[];
  cutoff: Date;
  limit?: number;
  /**
   * I progetti che chi guarda vede (la rotta): il progetto del thread è
   * l'ultimo ammesso attribuito a uno di QUESTI, e un thread senza progetti
   * visibili non c'è. Assente = tutti (il worker giudica la casella intera).
   */
  projects?: "all" | readonly string[];
  /** La rotta: toglie i thread il cui ultimo messaggio è giudicato «no». */
  shownOnly?: boolean;
  /**
   * Il worker (J2): solo i thread il cui ultimo messaggio NON ha un giudizio
   * e ha meno di questi tentativi. Nella WHERE, prima del `limit`: filtrarli
   * dopo lasciava una casella con 200 thread già giudicati (e più vecchi)
   * senza più nessun candidato (review finale, 15 nov 2026).
   */
  unjudgedBelowAttempts?: number;
}

export async function waitingCandidates(db: Db, input: WaitingCandidatesInput): Promise<WaitingCandidate[]> {
  return (await waitingCandidatesPage(db, input)).items;
}

/** Come `waitingCandidates`, più `total`: quanti passano, oltre il `limit`. */
export async function waitingCandidatesPage(db: Db, input: WaitingCandidatesInput): Promise<{ items: WaitingCandidate[]; total: number }> {
  if (input.accountIds.length === 0) return { items: [], total: 0 };
  const projects = input.projects ?? "all";
  if (projects !== "all" && projects.length === 0) return { items: [], total: 0 };
  const visibleProject =
    projects === "all"
      ? sql`true`
      : sql`coalesce(project_id, scope_project_ids[1]) in (${sql.join(
          projects.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`;
  const shown = input.shownOnly ? sql`coalesce(last.reply_judgment->>'needsMyReply', '') <> 'false'` : sql`true`;
  const unjudged =
    input.unjudgedBelowAttempts !== undefined
      ? sql`last.reply_judgment is null and last.reply_judgment_attempts < ${input.unjudgedBelowAttempts}`
      : sql`true`;
  const ids = sql.join(
    input.accountIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await db.execute<{
    account_id: string;
    account_email: string;
    thread_id: string;
    last_id: string;
    last_from: string;
    waiting_since: Date | string;
    customer_email: string;
    customer_name: string | null;
    subject: string | null;
    project_id: string;
    importance: "high" | "normal" | "low" | null;
    reply_judgment: WaitingCandidate["replyJudgment"];
    reply_judgment_attempts: number;
    signal: string | null;
    total: number | string;
  }>(sql`
    with msgs as (
      select m.*, row_number() over (partition by m.account_id, m.thread_id order by m.received_at desc, m.id desc) as rn
      from email_messages m
      where m.account_id in (${ids})
    ),
    last as (select * from msgs where rn = 1),
    instance as (select lower(email) as e from google_accounts),
    ext as (
      select account_id, thread_id, max(received_at) as at,
        (array_agg(from_address order by received_at desc, id desc))[1] as addr,
        (array_agg(from_name order by received_at desc, id desc))[1] as name
      from email_messages
      where account_id in (${ids}) and lower(from_address) not in (select e from instance)
      group by account_id, thread_id
    ),
    adm as (
      select account_id, thread_id,
        (array_agg(coalesce(project_id, scope_project_ids[1]) order by received_at desc, id desc)
          filter (where admitted and coalesce(project_id, scope_project_ids[1]) is not null and ${visibleProject}
            -- Registro, A8 «Clienti in attesa»: un progetto che non c'è più (il perimetro
            -- scope_project_ids non ha chiave esterna) non fa una riga, né conta in total.
            and exists (select 1 from projects pr where pr.id = coalesce(project_id, scope_project_ids[1]))))[1] as project_id,
        (array_agg(status order by received_at desc, id desc) filter (where admitted))[1] as status,
        (array_agg(importance order by received_at desc, id desc) filter (where admitted))[1] as importance,
        (array_agg(subject order by received_at desc, id desc) filter (where admitted))[1] as subject
      from email_messages
      where account_id in (${ids})
      group by account_id, thread_id
      having bool_or(admitted)
    )
    select last.account_id, a.email as account_email, last.thread_id, last.id as last_id, last.from_address as last_from,
      ext.at as waiting_since, ext.addr as customer_email, ext.name as customer_name, adm.subject, adm.project_id, adm.importance,
      last.reply_judgment, last.reply_judgment_attempts,
      (select p.classification->>'signal' from email_proposals p join email_messages pm on pm.id = p.email_message_id
        where pm.account_id = last.account_id and pm.thread_id = last.thread_id
        order by p.created_at desc, p.id desc limit 1) as signal,
      count(*) over () as total
    from last
    join google_accounts a on a.id = last.account_id
    join adm on adm.account_id = last.account_id and adm.thread_id = last.thread_id
    join ext on ext.account_id = last.account_id and ext.thread_id = last.thread_id
    where lower(last.from_address) <> lower(a.email)
      and ext.at < ${input.cutoff.toISOString()}::timestamptz
      and adm.project_id is not null
      -- (e): new/failed (non classificato) e ogni stato non ignored passano; ignored solo con importanza alta.
      and (adm.status <> 'ignored' or adm.importance = 'high')
      and ${shown}
      and ${unjudged}
      and not exists (
        select 1 from mail_outgoing o
        where o.account_id = last.account_id and o.state = 'sent'
          and coalesce(o.gmail_thread_id, o.thread_id) = last.thread_id
          and o.sent_at > last.received_at
      )
    order by ext.at asc, last.thread_id
    limit ${input.limit ?? 200}
  `);
  const list = [...rows];
  const items = list.map((r) => ({
    accountId: r.account_id,
    accountEmail: r.account_email,
    threadId: r.thread_id,
    lastMessageId: r.last_id,
    lastFromAddress: r.last_from,
    waitingSince: new Date(r.waiting_since),
    customerEmail: r.customer_email,
    customerName: r.customer_name,
    subject: r.subject,
    projectId: r.project_id,
    importance: r.importance,
    replyJudgment: r.reply_judgment,
    replyJudgmentAttempts: r.reply_judgment_attempts,
    signal: r.signal,
  }));
  return { items, total: list.length === 0 ? 0 : Number(list[0]!.total) };
}
