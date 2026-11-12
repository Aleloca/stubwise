import { googleAccounts, mailDrafts, mailOutgoing, type Db } from "@stubwise/db";
import { GoogleApiError, refreshAccessToken, sendDraft } from "@stubwise/google";
import { loadGoogleAccountCredentials, type GoogleAccountCredentials } from "@stubwise/google/credentials";
import { MAIL_OUTGOING_CHANNEL } from "@stubwise/shared";
import { eq, sql } from "drizzle-orm";

/**
 * L'INVIO DELLA POSTA ALLO SCADERE DEI 10 SECONDI (area 6, fetta 3, D6).
 *
 * Il worker manda un'email SOLO perché una persona ha premuto Invia: la riga
 * `mail_outgoing` (scritta dalla rotta, con chi e quando) è il gesto, e il
 * worker la esegue a `send_at`. Regole:
 * - il claim è un UPDATE `queued → sending` con `FOR UPDATE SKIP LOCKED`:
 *   una riga la manda UN giro, e un Annulla all'ultimo istante (che blocca la
 *   stessa riga e ricontrolla) la porta via prima o non la trova più `queued`;
 * - un fallimento resta `failed` col suo codice: MAI un ritentativo
 *   automatico (Riprova è un gesto);
 * - all'avvio una riga rimasta `sending` (il worker è morto a metà) diventa
 *   `failed` con `interrupted`: non si sa se Gmail l'abbia mandata, e
 *   rimandarla rischierebbe due email. La persona guarda Gmail e decide.
 */

export interface MailSenderClient {
  refreshAccessToken: typeof refreshAccessToken;
  sendDraft: typeof sendDraft;
}

export interface MailSenderDeps {
  db: Db;
  encryptionKey: Buffer;
  client?: MailSenderClient;
  loadCredentials?: (db: Db, key: Buffer, accountId: string) => Promise<GoogleAccountCredentials | null>;
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  batch?: number;
}

const realClient: MailSenderClient = { refreshAccessToken, sendDraft };

/** Il codice d'errore che la persona può leggere (`delivery.error`). */
export function sendErrorCode(err: unknown): string {
  if (err instanceof GoogleApiError) {
    if (err.code === "invalid_grant" || err.status === 401) return "token_expired";
    if (err.code === "insufficient_scope") return "google_scope_missing";
    if (err.code === "rate_limited" || err.status === 429) return "quota";
    if (err.status === 404) return "draft_gone";
    if (err.status === 400) return "invalid_message";
  }
  return "other";
}

/** All'avvio: gli invii interrotti a metà diventano falliti (mai rimandati da soli). */
export async function recoverInterruptedSends(db: Db): Promise<number> {
  const rows = await db
    .update(mailOutgoing)
    .set({ state: "failed", error: "interrupted" })
    .where(eq(mailOutgoing.state, "sending"))
    .returning({ id: mailOutgoing.id });
  return rows.length;
}

/** UN giro: reclama gli invii dovuti e li manda, uno per uno. Non lancia. */
export async function sendDueMail(deps: MailSenderDeps): Promise<{ sent: number; failed: number }> {
  const client = deps.client ?? realClient;
  const load = deps.loadCredentials ?? loadGoogleAccountCredentials;
  const logger = deps.logger ?? { info: () => {}, warn: () => {}, error: () => {} };
  const stats = { sent: 0, failed: 0 };
  let claimed: (typeof mailOutgoing.$inferSelect)[];
  try {
    claimed = await deps.db
      .update(mailOutgoing)
      .set({ state: "sending" })
      .where(
        sql`${mailOutgoing.id} in (
          select id from mail_outgoing where state = 'queued' and send_at <= now()
          order by send_at limit ${deps.batch ?? 10} for update skip locked
        )`,
      )
      .returning();
  } catch (err) {
    logger.error(`posta: claim degli invii fallito: ${err instanceof Error ? err.message : String(err)}`);
    return stats;
  }
  for (const row of claimed) {
    try {
      const [account] = await deps.db.select({ disabledAt: googleAccounts.disabledAt }).from(googleAccounts).where(eq(googleAccounts.id, row.accountId));
      if (!account || account.disabledAt) throw new SendRefused("account_disabled");
      const credentials = await load(deps.db, deps.encryptionKey, row.accountId);
      if (!credentials) throw new SendRefused("account_unavailable");
      const tokens = await client.refreshAccessToken({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        refreshToken: credentials.refreshToken,
      });
      const sent = await client.sendDraft({ accessToken: tokens.accessToken, id: row.gmailDraftId });
      await deps.db.transaction(async (tx) => {
        await tx
          .update(mailOutgoing)
          .set({ state: "sent", gmailMessageId: sent.messageId, gmailThreadId: sent.threadId, sentAt: sql`now()`, error: null })
          .where(eq(mailOutgoing.id, row.id));
        // La bozza è uscita da Gmail: anche da qui.
        if (row.draftId) await tx.delete(mailDrafts).where(eq(mailDrafts.id, row.draftId));
      });
      stats.sent += 1;
    } catch (err) {
      const code = err instanceof SendRefused ? err.message : sendErrorCode(err);
      await deps.db.update(mailOutgoing).set({ state: "failed", error: code }).where(eq(mailOutgoing.id, row.id));
      logger.warn(`posta: invio ${row.id} fallito (${code})`);
      stats.failed += 1;
    }
  }
  return stats;
}

class SendRefused extends Error {}

/**
 * Avvia il mittente: un giro ogni `pollMs` (default 2 s) e a ogni NOTIFY del
 * server. Una sveglia a giro in corso fa ripartire il giro appena finisce.
 */
export function startMailSender(
  deps: MailSenderDeps & {
    signal: AbortSignal;
    listen?: (channel: string, cb: (payload: string) => void) => Promise<unknown>;
    pollMs?: number;
  },
): () => void {
  const logger = deps.logger ?? { info: () => {}, warn: () => {}, error: () => {} };
  let running = false;
  let again = false;
  const tick = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    again = false;
    try {
      await sendDueMail(deps);
    } finally {
      running = false;
      if (again && !deps.signal.aborted) void tick();
    }
  };
  // PRIMA il recupero, POI la sveglia e il timer: un giro partito prima del
  // recupero reclamerebbe una riga (`sending`) che il recupero segnerebbe
  // fallita mentre parte.
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  void recoverInterruptedSends(deps.db)
    .then((n) => {
      if (n > 0) logger.warn(`posta: ${n} invii interrotti da un riavvio segnati falliti (non si rimandano da soli)`);
    })
    .catch((err: unknown) => logger.error(`posta: recupero degli invii interrotti fallito: ${String(err)}`))
    .finally(() => {
      if (stopped || deps.signal.aborted) return;
      if (deps.listen) {
        deps.listen(MAIL_OUTGOING_CHANNEL, () => {
          if (!deps.signal.aborted) void tick();
        }).catch((err: unknown) => logger.warn(`posta: LISTEN degli invii fallito, resta il controllo periodico: ${String(err)}`));
      }
      timer = setInterval(() => void tick(), deps.pollMs ?? 2000);
      timer.unref?.();
      void tick();
    });
  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
  deps.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
