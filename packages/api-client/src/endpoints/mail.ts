import {
  mailDetailSchema,
  mailOriginalSchema,
  mailPageSchema,
  mailRejectionsSchema,
  mailReproposeResultSchema,
  mailSummarySchema,
  mailThreadDetailSchema,
  mailThreadPageSchema,
  mailProposalListSchema,
  mailProposalSchema,
  mailProposalDecisionSchema,
  mailDraftListSchema,
  mailDraftSchema,
  mailRecipientSuggestionListSchema,
  mailDraftRestoreSchema,
  mailOutgoingSchema,
} from "@stubwise/shared";
import type {
  Reader,
  MailDetail,
  MailItemStatus,
  MailOriginal,
  MailPage,
  MailRejections,
  MailReproposeResult,
  MailSource,
  MailSummary,
  MailThreadDetail,
  MailThreadPage,
  MailImportance,
  MailProposal,
  MailProposalList,
  MailProposalStatus,
  MailProposalDecision,
  MailComposeMode,
  MailDraftList,
  MailDraft,
  MailRecipientSuggestionList,
  MailDraftSave,
  MailDraftRestore,
  MailOutgoing,
} from "@stubwise/shared";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/** Filtri di `GET /api/me/mail`. */
export interface MailFilters {
  account?: string;
  /**
   * Da quale sorgente leggere: `"email"` (posta e smistamenti) o
   * `"calendar"` (appuntamenti). Assente = entrambe, il comportamento
   * storico su cui la pagina `/mail` del web si appoggia. Lo usa la scheda
   * MBX dell'app, dove Posta e Calendario sono due viste distinte.
   */
  source?: MailSource;
  status?: MailItemStatus;
  project?: string;
}

/**
 * `id` di `GET /:source/:id` e `/:source/:id/original`: SOLO due dei tre
 * valori che il server accetta sulla rotta gemella di repropose
 * (`reproposeSourceSchema`, `apps/server/src/routes/me-mail.ts`) — il
 * dettaglio e la rilettura esistono solo per la posta, mai per un evento di
 * calendario, che non ha un "estratto" né un messaggio Gmail da rileggere
 * (i suoi campi sono già tutti nella riga di `MailItem`). `"email_triage"`
 * regge lo stesso spazio di id di `"email"`: il PADRE `email_messages` di
 * una proposta di smistamento, senza figli.
 */
export type MailDetailSource = "email" | "email_triage";

/** `id` di `POST /:source/:id/repropose`: le TRE sorgenti reali, vedi `MailDetailSource` sopra per il perché del terzo valore. */
export type MailReproposeSource = "email" | "calendar" | "email_triage";

/**
 * Posta (fase 6/6b/6c, 9): i messaggi Gmail e gli eventi di calendario
 * TRATTATI dal poller, per l'utente autenticato — `user_id` sempre nel WHERE
 * lato server, nessun ruolo scavalca (`apps/server/src/routes/me-mail.ts`).
 *
 * La lista è corta per costruzione (solo la posta AMMESSA entra): 33
 * messaggi su quattro caselle in produzione al momento in cui questo client
 * è stato scritto — non è una lista da client di posta.
 */
/**
 * I filtri di `threads` in forma d'oggetto (area 6, F1.4). `q`: la ricerca
 * nella pagina, da 2 a 200 caratteri dopo il trim (sotto, 400
 * `invalid_query`; vuoto = nessun filtro), in oggetto, mittente (nome e
 * indirizzo) ed estratto, mai in `to`/`cc`. Un thread passa se un suo
 * messaggio combacia.
 */
export interface MailThreadQuery {
  account?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  q?: string | undefined;
  /** Area 6, F2: solo le conversazioni di questa importanza. */
  importance?: MailImportance | undefined;
  /** Area 6, F2: solo quelle di questo progetto (id). */
  project?: string | undefined;
  /** Area 6, F2: solo quelle classificate senza progetto («Senza progetto»). */
  noProject?: boolean | undefined;
  /**
   * Area 6, F2: le «Importanti» (e il blocco Home «Posta importante»): almeno
   * un messaggio di importanza alta NON letto, dalla più recente.
   */
  important?: boolean | undefined;
}

export function createMailEndpoints(request: ApiRequest) {
  return {
    list(filters: MailFilters = {}, cursor?: string, limit?: number): Promise<Reader<MailPage>> {
      const query = toQuery({
        account: filters.account,
        source: filters.source,
        status: filters.status,
        project: filters.project,
        cursor,
        limit,
      });
      return request("GET", `/api/me/mail${query}`, undefined, mailPageSchema);
    },

    /**
     * La posta per CONVERSAZIONE («la posta si legge per conversazione» §4):
     * una riga per thread invece che una per messaggio.
     *
     * ⚠️ Vive ACCANTO a {@link list}, non al suo posto: quella la legge
     * un'app già installata e la usa anche il calendario, che thread non ne
     * ha. Chi disegna una lista di posta usa questa; chi mostra anche gli
     * appuntamenti resta su `list`.
     */
    threads(
      accountOrOptions?: string | MailThreadQuery,
      cursor?: string,
      limit?: number,
    ): Promise<Reader<MailThreadPage>> {
      // Due firme: quella posizionale di prima (web e app la usano) e
      // l'oggetto (area 6, F1.4), che porta anche `q`.
      const options: MailThreadQuery =
        typeof accountOrOptions === "object" ? accountOrOptions : { account: accountOrOptions, cursor, limit };
      const query = toQuery({
        account: options.account,
        cursor: options.cursor,
        limit: options.limit,
        q: options.q,
        importance: options.importance,
        project: options.project,
        noProject: options.noProject ? "true" : undefined,
        important: options.important ? "true" : undefined,
      });
      return request("GET", `/api/me/mail/threads${query}`, undefined, mailThreadPageSchema);
    },

    /**
     * Le proposte CONDIVISE (area 6, F2, D4) che chi guarda può vedere:
     * quelle di un messaggio della sua casella (`message`), per stato. I
     * permessi (`canConfirm`, `blockedIndices`, …) li calcola il server.
     */
    proposals(filter: { message?: string; status?: MailProposalStatus } = {}): Promise<Reader<MailProposalList>> {
      return request("GET", `/api/me/mail/proposals${toQuery({ message: filter.message, status: filter.status })}`, undefined, mailProposalListSchema);
    },

    /** Una proposta condivisa; 404 `not_found` se chi guarda non la vede. */
    proposal(id: string): Promise<Reader<MailProposal>> {
      return request("GET", `/api/me/mail/proposals/${seg(id)}`, undefined, mailProposalSchema);
    },

    /**
     * Decidere (area 6, F2). L'esito 200 è `MailProposalDecision`; gli errori
     * sono `ApiError`: 409 `already_handled` (con `decidedBy` nei `details`),
     * 403 `forbidden`, 400 `invalid_selection` / `invalid_edits` /
     * `invalid_assignee` / `invalid_target`, 404 `not_found`.
     */
    confirmProposal(id: string, body: { indices?: number[]; edits?: Record<string, Record<string, unknown>> } = {}): Promise<Reader<MailProposalDecision>> {
      return request("POST", `/api/me/mail/proposals/${seg(id)}/confirm`, body, mailProposalDecisionSchema);
    },
    /** Conferma aggiungendo come Contributor gli incaricati fuori dal progetto: chiede la riconferma (`reauth_required`). */
    confirmProposalWithMembers(
      id: string,
      body: { indices?: number[]; edits?: Record<string, Record<string, unknown>>; addOutsiders: string[] },
    ): Promise<Reader<MailProposalDecision>> {
      return request("POST", `/api/me/mail/proposals/${seg(id)}/confirm-with-members`, body, mailProposalDecisionSchema);
    },
    ignoreProposal(id: string): Promise<Reader<MailProposalDecision>> {
      return request("POST", `/api/me/mail/proposals/${seg(id)}/ignore`, {}, mailProposalDecisionSchema);
    },
    /** «Passa al progetto» (solo chi non può confermarla). */
    handProposal(id: string): Promise<Reader<MailProposalDecision>> {
      return request("POST", `/api/me/mail/proposals/${seg(id)}/hand`, {}, mailProposalDecisionSchema);
    },
    /** «Sposta su un altro progetto»: `{ status: "moved", projectId }`. */
    reassignProposal(id: string, projectId: string): Promise<Reader<MailProposalDecision>> {
      return request("POST", `/api/me/mail/proposals/${seg(id)}/reassign`, { projectId }, mailProposalDecisionSchema);
    },
    /** «Quale progetto?»: l'email si riclassifica per quello scelto. */
    chooseProposalProject(id: string, projectId: string): Promise<Reader<MailProposalDecision>> {
      return request("POST", `/api/me/mail/proposals/${seg(id)}/choose-project`, { projectId }, mailProposalDecisionSchema);
    },

    /** Area 6, F3: le MIE bozze (bozze di Gmail). */
    drafts(): Promise<Reader<MailDraftList>> {
      return request("GET", "/api/me/mail/drafts", undefined, mailDraftListSchema);
    },
    /**
     * «La bozza di» una conversazione: quella salvata, o una nuova già
     * indirizzata dal server (`id` null). Non salva e non chiama Google.
     */
    draft(input: { account: string; thread?: string | null; mode: MailComposeMode; replyTo?: string | null }): Promise<Reader<MailDraft>> {
      const query = toQuery({ account: input.account, thread: input.thread ?? undefined, mode: input.mode, replyTo: input.replyTo ?? undefined });
      return request("GET", `/api/me/mail/drafts/compose${query}`, undefined, mailDraftSchema);
    },
    /**
     * Salva (crea o sostituisce) la bozza dello slot, su Gmail. Errori: 409
     * `draft_changed` (modificata da Gmail nel frattempo), `google_scope_missing`
     * (con `missing`), `account_disabled`, `token_expired`; 404; 502.
     */
    saveDraft(input: MailDraftSave): Promise<Reader<MailDraft>> {
      return request("PUT", "/api/me/mail/drafts", input, mailDraftSchema);
    },
    /**
     * Invia (D6): il server lo trattiene 10 s, fino a `undoUntil`. `messageId`
     * è l'id dell'invio. Un doppio Invia restituisce lo stesso invio.
     */
    sendDraft(id: string): Promise<Reader<MailOutgoing>> {
      return request("POST", `/api/me/mail/drafts/${seg(id)}/send`, {}, mailOutgoingSchema);
    },
    /** Lo stato di un invio (`queued`, `sending`, `sent`, `failed` con `error`, `cancelled`). */
    outgoing(messageId: string): Promise<Reader<MailOutgoing>> {
      return request("GET", `/api/me/mail/outgoing/${seg(messageId)}`, undefined, mailOutgoingSchema);
    },
    /** Annulla prima di `undoUntil`: la bozza torna. Dopo, 409 `too_late`; con un'altra bozza nello slot, 409 `draft_slot_taken`. */
    undoSend(messageId: string): Promise<Reader<MailDraftRestore>> {
      return request("POST", `/api/me/mail/outgoing/${seg(messageId)}/undo`, {}, mailDraftRestoreSchema);
    },
    /** Riprova un invio fallito (un gesto: il server non ritenta mai da solo). */
    retrySend(messageId: string): Promise<Reader<MailOutgoing>> {
      return request("POST", `/api/me/mail/outgoing/${seg(messageId)}/retry`, {}, mailOutgoingSchema);
    },
    /** Elimina un invio fallito: la bozza torna, da correggere. */
    deleteFailedSend(messageId: string): Promise<Reader<MailDraftRestore>> {
      return request("POST", `/api/me/mail/outgoing/${seg(messageId)}/discard`, {}, mailDraftRestoreSchema);
    },
    /**
     * Allega un file dal disco a una bozza GIÀ salvata (multipart, campo
     * `file`, al più 10 file e 25 MB in tutto): la bozza su Gmail si riscrive
     * col file e la risposta è la bozza. 400 `too_large` /
     * `too_many_attachments` / `storage_not_configured`, 404 se la bozza non è
     * di chi scrive.
     */
    uploadAttachment(draftId: string, file: Blob, filename: string): Promise<Reader<MailDraft>> {
      const form = new FormData();
      form.append("file", file, filename);
      return request("POST", `/api/me/mail/drafts/${seg(draftId)}/attachments`, form, mailDraftSchema);
    },
    /**
     * Allega un file del Drive del progetto, come copia letta a ogni
     * salvataggio col permesso di chi scrive. 409 `attachment_unavailable`
     * per un file che chi scrive non vede (o eliminato).
     */
    attachDriveFile(draftId: string, driveFileId: string): Promise<Reader<MailDraft>> {
      return request("POST", `/api/me/mail/drafts/${seg(draftId)}/attachments/drive`, { driveFileId }, mailDraftSchema);
    },
    /** Toglie un allegato; la bozza su Gmail si riscrive senza. */
    removeAttachment(draftId: string, attachmentId: string): Promise<Reader<MailDraft>> {
      return request("DELETE", `/api/me/mail/drafts/${seg(draftId)}/attachments/${seg(attachmentId)}`, undefined, mailDraftSchema);
    },
    /**
     * I destinatari suggeriti mentre si scrive un indirizzo: prima il team
     * che chi scrive vede (`group: "team"`, con `personId`), poi gli indirizzi
     * delle sue caselle (`"mail"`). Una q vuota dà una lista vuota.
     */
    recipients(q: string): Promise<Reader<MailRecipientSuggestionList>> {
      return request("GET", `/api/me/mail/recipients?${new URLSearchParams({ q }).toString()}`, undefined, mailRecipientSuggestionListSchema);
    },
    /** Elimina la bozza, su Gmail e in Stubwise. «Annulla» = salvarla di nuovo. */
    discardDraft(id: string): Promise<void> {
      return request("DELETE", `/api/me/mail/drafts/${seg(id)}`);
    },

    /**
     * Letto / non letto su GMAIL (area 6, F1.3): scrive sulla casella (tutto
     * il thread) e lo stato locale solo dopo il sì di Google; risponde col
     * dettaglio aggiornato. 409 `google_scope_missing` (con `missing` nei
     * `details`) per una casella da ricollegare, `account_disabled`,
     * `token_expired`; 404 un thread non tuo; 503 `google_rate_limited` (quota di
     * Gmail: riprova); 502 `google_unavailable`. Ogni errore lascia lo stato com'era.
     */
    setRead(threadId: string, account: string, read: boolean): Promise<Reader<MailThreadDetail>> {
      return request("POST", `/api/me/mail/threads/${seg(threadId)}/read`, { account, read }, mailThreadDetailSchema);
    },

    /**
     * Il dettaglio di una conversazione: i messaggi in ordine, ciascuno con
     * la sua provenienza — `admitted: false` è un messaggio tirato dentro
     * come CONTESTO del thread, che si legge ma non produce proposte.
     *
     * `threadId` è l'id Gmail del thread, non un uuid. `account` serve solo
     * quando lo stesso thread è su due caselle dello stesso utente.
     */
    thread(threadId: string, account?: string): Promise<Reader<MailThreadDetail>> {
      return request(
        "GET",
        `/api/me/mail/threads/${seg(threadId)}${toQuery({ account })}`,
        undefined,
        mailThreadDetailSchema,
      );
    },

    /** Contatori per il badge di nav e l'intestazione della pagina. */
    summary(): Promise<Reader<MailSummary>> {
      return request("GET", "/api/me/mail/summary", undefined, mailSummarySchema);
    },

    /**
     * Le mail tenute fuori dal cancello di ammissione, per casella, motivo e
     * dominio, negli ultimi `days` giorni (1..30; assente = default del
     * server, 7). Solo le caselle di chi chiede. Un server più vecchio
     * risponde 404: la lettura è accessoria, chi la usa la nasconde.
     */
    rejections(days?: number): Promise<Reader<MailRejections>> {
      return request("GET", `/api/me/mail/rejections${toQuery({ days })}`, undefined, mailRejectionsSchema);
    },

    /**
     * Dettaglio dall'ESTRATTO già in database — nessuna chiamata a Google,
     * funziona anche a token scaduto o con Google irraggiungibile.
     * `textExcerpt` è `null` sui messaggi anteriori alla fase 6 (il poller
     * non l'ha salvato): non è un errore, va dichiarato assente, non un
     * campo vuoto.
     */
    get(source: MailDetailSource, id: string): Promise<Reader<MailDetail>> {
      return request("GET", `/api/me/mail/${seg(source)}/${seg(id)}`, undefined, mailDetailSchema);
    },

    /**
     * Il messaggio ORIGINALE, riletto da Gmail SU RICHIESTA — non persiste
     * nulla, è una finestra su Gmail, non una copia. Errori veri: 409
     * `message_gone` (cancellato/spostato su Gmail), 409 `token_expired`
     * (la casella va ricollegata), 502 `google_unavailable`. In ogni caso
     * l'estratto di `get()` resta leggibile: questa è solo un supplemento.
     */
    original(source: MailDetailSource, id: string): Promise<Reader<MailOriginal>> {
      return request("GET", `/api/me/mail/${seg(source)}/${seg(id)}/original`, undefined, mailOriginalSchema);
    },

    /**
     * Riproponi una riga `failed`/`ignored`: NON pubblica una proposta nuova
     * da qui, resetta solo lo stato perché il prossimo tick del poller la
     * riprenda. 409 `not_reproposable` se lo stato non lo permette.
     */
    repropose(source: MailReproposeSource, id: string): Promise<Reader<MailReproposeResult>> {
      return request(
        "POST",
        `/api/me/mail/${seg(source)}/${seg(id)}/repropose`,
        undefined,
        mailReproposeResultSchema,
      );
    },
  };
}
