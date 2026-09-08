/**
 * PARTE PURA del poller Gmail (fase 6, Task 7): tutto ciò che decide *cosa*
 * fare, senza database, senza rete e senza orologio implicito.
 *
 * Sta in un modulo a sé perché è la metà del poller che si sbaglia davvero — il
 * backoff, la mappatura di un errore di Google su un motivo di disabilitazione,
 * la costruzione dell'oggetto che il routing legge — e l'unica che si può
 * testare in millisecondi. `poller.ts` accanto è l'altra metà: claim, chiamate,
 * scritture, e nessuna decisione che non passi da qui.
 *
 * @see poller.ts per l'orchestrazione del tick.
 */
import type { GmailMessage } from "@stubwise/google";
import { GoogleApiError, isFatalGoogleError } from "@stubwise/google";
import { normalizeAddress, parseAddressList, type EmailForRouting } from "@stubwise/notifications";

/**
 * Tentativi transitori consecutivi dopo i quali la casella viene disabilitata
 * con motivo `sync_failed`.
 *
 * Otto è il numero del design: con la base e il tetto qui sotto sono ~2 ore di
 * ritentativi prima di dire a un umano «questa casella non risponde più». Meno
 * significherebbe spegnere una casella per un pomeriggio storto di Google; di
 * più, tenerla in un limbo che nessuno guarda.
 */
export const GMAIL_MAX_SYNC_ATTEMPTS = 8;

/** Base del backoff esponenziale fra due tentativi falliti: 60s, 120s, 240s… */
export const SYNC_BACKOFF_BASE_SECONDS = 60;

/**
 * Esponente massimo del backoff: oltre, l'attesa resta ferma a
 * `60 * 2^6` = 64 minuti. Senza tetto l'ottavo tentativo cadrebbe più di due
 * ore dopo il settimo, e la casella resterebbe "in errore" senza che nessuno
 * veda mai il `sync_failed` che chiude la storia.
 */
export const SYNC_BACKOFF_MAX_EXPONENT = 6;

/**
 * La query del RESYNC: primo giro della casella, o history che Gmail non
 * conserva più. `-from:me` esclude a monte ciò che la casella ha SPEDITO — la
 * posta in uscita non è una richiesta ricevuta —, ma non è l'unica difesa:
 * il percorso incrementale (History API) non ha una query dove metterlo, quindi
 * {@link isFromMailbox} rifà il controllo in codice per entrambi i percorsi.
 */
export const GMAIL_RESYNC_QUERY = "newer_than:7d -from:me";

/** Tetto di messaggi che un resync guarda: oltre, si aspetta il tick dopo. */
export const GMAIL_RESYNC_MAX_MESSAGES = 200;

/**
 * Stati TERMINALI di `email_messages`.
 *
 * `new`, `classified` e `proposed` sono lavoro in corso o una proposta ancora
 * aperta nella inbox di qualcuno: cancellarli farebbe sparire una card sotto le
 * dita del destinatario.
 *
 * ⚠️ Fase 6b: questa lista NON basta più, da sola, a decidere la potabilità di
 * un messaggio (`pruneOldEmails` in `poller.ts`). Dalla classificazione in poi
 * il padre non avanza più il proprio `status` a `actioned` — quello lo fanno
 * solo i FIGLI (`email_proposals`, {@link TERMINAL_EMAIL_PROPOSAL_STATUSES}),
 * uno per progetto — quindi un messaggio con figli resta `classified` per
 * sempre, anche quando ogni figlio è chiuso. La retention usa perciò `status
 * <> 'new'` come guardia minima sul padre (un messaggio mai classificato non
 * ha mai avuto la possibilità di generare figli) più la condizione sui figli.
 * Questa costante resta comunque il riferimento per gli stati "chiusi" del
 * padre nelle righe SENZA figli (legacy pre-6b, o classificazioni senza
 * candidati validi).
 */
export const TERMINAL_EMAIL_STATUSES = ["actioned", "ignored", "failed"] as const;

/**
 * Stati TERMINALI di `email_proposals` (fase 6b): il figlio non ha più niente
 * da fare — `classified` è una proposta non ancora pubblicata, `proposed` una
 * card ancora aperta nella inbox del proprietario della casella.
 *
 * I valori letterali coincidono con {@link TERMINAL_EMAIL_STATUSES} — stesso
 * significato, "questa riga non genera più nessuna azione" — ma è una
 * costante A SÉ perché vive su un'altra tabella e un altro tipo union
 * (`email_proposals.status` non conosce `new`, che non esiste per un figlio:
 * una riga nasce già `classified`).
 */
export const TERMINAL_EMAIL_PROPOSAL_STATUSES = ["actioned", "ignored", "failed"] as const;

/** I motivi ammessi da `google_accounts.disabled_reason` (CHECK in schema). */
export type GoogleDisabledReason =
  | "revoked"
  | "invalid_grant"
  | "insufficient_scope"
  | "workspace_removed"
  | "sync_failed";

/** Attesa (ms) prima del tentativo successivo a `attempt` fallimenti (0-based). */
export function syncBackoffMs(attempt: number): number {
  const exponent = Math.min(Math.max(attempt, 0), SYNC_BACKOFF_MAX_EXPONENT);
  return SYNC_BACKOFF_BASE_SECONDS * 1000 * 2 ** exponent;
}

/**
 * Quanto aspettare dopo un errore TRANSITORIO.
 *
 * `Retry-After` di Google vince sul backoff quando c'è: è l'unica informazione
 * che viene da chi conosce davvero la quota, e ignorarla per una formula
 * significa bussare di nuovo prima che la porta si sia riaperta. Quando manca —
 * rete, timeout, 5xx — resta il backoff esponenziale sui tentativi accumulati.
 *
 * @param attempt tentativi GIÀ falliti prima di questo (0-based)
 * @param error l'errore che ha fatto fallire il giro
 */
export function nextSyncDelayMs(attempt: number, error: unknown): number {
  if (error instanceof GoogleApiError && error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }
  return syncBackoffMs(attempt);
}

/**
 * Il motivo con cui disabilitare la casella, o `null` se l'errore non è fatale.
 *
 * La mappatura è quella del design: `invalid_grant` e `insufficient_scope`
 * hanno un motivo proprio, `unauthorized_client` e `access_denied` ricadono su
 * `revoked` — per l'utente sono la stessa cosa («il consenso non c'è più»), e
 * moltiplicare i motivi non aiuterebbe nessuno a rimediare.
 *
 * ⚠️ `sync_failed` NON esce da qui: non è un verdetto di Google ma il nostro,
 * dopo {@link GMAIL_MAX_SYNC_ATTEMPTS} errori transitori di fila.
 */
export function disabledReasonFor(error: unknown): GoogleDisabledReason | null {
  if (!isFatalGoogleError(error)) return null;
  const code = (error as GoogleApiError).code;
  if (code === "invalid_grant") return "invalid_grant";
  if (code === "insufficient_scope") return "insufficient_scope";
  return "revoked";
}

/**
 * L'errore dice «il tuo punto di ripartenza è troppo vecchio»?
 *
 * È il 404 di `history.list`, che `@stubwise/google` normalizza in
 * `history_expired` apposta: non è "non trovato" e non è fatale — si ricade sul
 * resync per query.
 */
export function isHistoryExpired(error: unknown): boolean {
  return error instanceof GoogleApiError && error.code === "history_expired";
}

/**
 * Il più RECENTE fra due cursori di history, o `null` se non ce n'è nessuno.
 *
 * Gli `historyId` di Gmail sono interi crescenti ma arrivano come stringhe e
 * superano da un pezzo il `Number.MAX_SAFE_INTEGER` di una casella viva: il
 * confronto passa da `BigInt`, non da `Number` né dall'ordine lessicografico
 * (che metterebbe `"9"` dopo `"10000"`). Un valore non numerico viene ignorato
 * invece di far saltare il giro.
 */
export function maxHistoryId(a: string | null, b: string | null): string | null {
  const parse = (value: string | null): bigint | null => {
    if (!value || !/^\d+$/.test(value)) return null;
    return BigInt(value);
  };
  const left = parse(a);
  const right = parse(b);
  if (left === null) return right === null ? null : b;
  if (right === null) return a;
  return right > left ? b : a;
}

/** Testo di un errore per il log e per `google_accounts` (mai un segreto dentro). */
export function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Il nome visualizzato di un header `From`, o `null` se l'header è il solo
 * indirizzo. `"Mario Rossi" <m@acme.com>` → `Mario Rossi`.
 */
export function displayNameOf(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const angled = raw.indexOf("<");
  if (angled === -1) return null;
  const name = raw.slice(0, angled).trim().replace(/^"(.*)"$/, "$1").trim();
  return name === "" ? null : name;
}

/**
 * Il messaggio l'ha spedito la casella stessa?
 *
 * Serve al percorso INCREMENTALE: `history.list` non ha una query in cui
 * infilare `-from:me`, quindi la posta in uscita arriverebbe fino al routing —
 * e una regola `sender_domain` sul proprio dominio la porterebbe dentro,
 * trasformando ogni risposta dell'operatore in una proposta per sé stesso.
 */
export function isFromMailbox(message: GmailMessage, mailboxEmail: string): boolean {
  const from = normalizeAddress(message.headers["from"]);
  return from !== "" && from === normalizeAddress(mailboxEmail);
}

/**
 * Il messaggio nella forma che il routing legge.
 *
 * `text` è opzionale ed è l'INTERO punto della funzione: al pre-filtro non c'è
 * (si hanno solo header ed etichette, e scaricare il corpo è ciò che si sta
 * cercando di evitare), alla risoluzione definitiva sì.
 */
export function messageToRouting(message: GmailMessage, text?: string): EmailForRouting {
  const routing: EmailForRouting = {
    fromAddress: message.headers["from"] ?? "",
    toAddresses: parseAddressList(message.headers["to"]),
    ccAddresses: parseAddressList(message.headers["cc"]),
    labels: message.labelIds,
    subject: message.headers["subject"] ?? "",
  };
  if (text !== undefined) routing.text = text;
  return routing;
}

/** La riga di `email_messages` da inserire, già pronta per l'insert. */
export interface EmailMessageInsert {
  accountId: string;
  gmailMessageId: string;
  threadId: string;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  subject: string | null;
  receivedAt: Date;
  labels: string[];
  textExcerpt: string | null;
  projectId: string | null;
  candidateProjectIds: string[];
  scopeProjectIds: string[];
  status: "new";
}

/**
 * Da messaggio Gmail (`full`) + esito del routing alla riga da scrivere.
 *
 * `receivedAt` cade su `now` quando Gmail non manda `internalDate`: la colonna
 * è NOT NULL e un messaggio senza data è comunque un messaggio da trattare —
 * l'alternativa sarebbe perderlo per un campo che non decide niente.
 * `textExcerpt` arriva già capato da `extractText`: qui non si taglia nulla,
 * si distingue solo il vuoto (`null`) dal testo.
 */
export function buildEmailMessageInsert(input: {
  accountId: string;
  message: GmailMessage;
  text: string;
  projectId: string | null;
  candidateProjectIds: string[];
  scopeProjectIds: string[];
  now: Date;
}): EmailMessageInsert {
  const { message } = input;
  const subject = message.headers["subject"]?.trim();
  return {
    accountId: input.accountId,
    gmailMessageId: message.id,
    threadId: message.threadId,
    fromAddress: normalizeAddress(message.headers["from"]),
    fromName: displayNameOf(message.headers["from"]),
    toAddresses: parseAddressList(message.headers["to"]),
    subject: subject ? subject : null,
    receivedAt: message.internalDate ?? input.now,
    labels: message.labelIds,
    textExcerpt: input.text.trim() === "" ? null : input.text,
    projectId: input.projectId,
    candidateProjectIds: input.candidateProjectIds,
    scopeProjectIds: input.scopeProjectIds,
    status: "new",
  };
}
