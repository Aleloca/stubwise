/**
 * PERCHÉ una proposta chiusa è finita lì (21 set 2026).
 *
 * `email_proposals.status` resta `ignored` per casi che non hanno niente in
 * comune — «il classificatore non ha trovato niente», «l'hai spostata tu su un
 * altro progetto», «la rigenerazione è fallita» — e letti come «ignorata» si
 * confondono. Lo stato dice **cosa si può ancora fare** con la riga (qui
 * sempre la stessa cosa: riproporre), l'esito dice **perché ci è arrivata**:
 * questa funzione traduce il secondo in un'etichetta, da mettere ACCANTO al
 * primo e mai al suo posto («Ignorata · spostata su Carelli» dice due cose
 * vere, «Spostata» da sola perderebbe che la riga è chiusa).
 *
 * Sta in `@stubwise/shared` e non in una delle due UI perché la leggono
 * entrambe: è la lezione di `./search-snippet.ts` (18 set 2026), dove la regola
 * viveva solo nel web ed è esattamente per quello che all'app mancava e il
 * maintainer vedeva i marcatori `<b>` in chiaro.
 *
 * ⚠️ **NON è una mappa esaustiva, e non deve diventarlo.** In produzione
 * esistono righe con `bulk_closed_automated` e `bulk_closed_stale_routing`:
 * esiti che **nessun codice produce** — li ha scritti a mano un maintainer
 * chiudendo l'arretrato del 17 settembre. Un `Record` esaustivo o uno `switch`
 * senza ramo di default andrebbe in crash sul dato vero al primo caricamento.
 * Un tipo sconosciuto vale `null`, e chi legge mostra lo stato nudo come oggi.
 *
 * ⚠️ **Solo gli esiti delle card chiuse SENZA azione.** Per quelle andate a
 * buon fine (`backlog_item`, `milestone_created`, `commented`…) l'etichetta di
 * stato «Eseguita» è già corretta e dice ciò che serve: aggiungerci un perché
 * sarebbe rumore. Chi mappa un esito nuovo si chieda prima se cade di qua o di
 * là.
 */

/** La chiave i18n di un esito, e se porta il nome di un progetto da interpolare. */
export interface ClosedReason {
  /** Chiave i18n dell'etichetta (`mail.closedReason.*`). */
  key: string;
  /**
   * `true` quando l'etichetta ha due forme — con e senza il nome del progetto
   * — e chi rende deve scegliere. Vedi {@link closedReasonProjectId}.
   */
  needsProject: boolean;
}

/**
 * Gli esiti che questa funzione sa spiegare, e la chiave di ciascuno.
 *
 * Un oggetto e non un `Record<string, …>` tipato sull'unione degli esiti: quei
 * valori non sono un enum da nessuna parte — vivono in un jsonb — e fingere
 * che lo siano è ciò che renderebbe questa mappa esaustiva per errore.
 */
const REASONS: Record<string, ClosedReason> = {
  /** L'utente l'ha spostata su un altro progetto (17 set 2026). */
  reassigned_to: { key: "closedReason.reassignedTo", needsProject: true },
  /**
   * ⚠️ L'UNICO che segnala un GUASTO, non una scelta. Chi rende lo distingua a
   * vista: è anche l'unico su cui «Riproponi» è la risposta giusta, e chi
   * legge «ignorata» non riprova.
   */
  reassign_failed: { key: "closedReason.reassignFailed", needsProject: false },
  /** Spostata, ma sul progetto nuovo non è sopravvissuta nessuna proposta. */
  reassign_no_signal: { key: "closedReason.reassignNoSignal", needsProject: false },
  /** Il progetto scelto è sparito fra la riattribuzione e il tick del worker. */
  reassign_target_gone: { key: "closedReason.reassignTargetGone", needsProject: false },
  /** Superata da un messaggio successivo dello stesso scambio (14 set 2026). */
  superseded_in_thread: { key: "closedReason.supersededInThread", needsProject: false },
  /** Calendario: l'invito è stato rifiutato su Google (15 set 2026). */
  declined: { key: "closedReason.declined", needsProject: false },
  /** Smistamento chiuso con «nessuno di questi» (fase 6c). */
  triage_dismissed: { key: "closedReason.triageDismissed", needsProject: false },
};

/**
 * Il `type` di un esito, se il jsonb ne porta uno leggibile.
 *
 * `outcome` è `Record<string, unknown>`: il `type` può mancare, o non essere
 * una stringa, su una riga scritta da una versione precedente o a mano.
 */
function outcomeType(outcome: Record<string, unknown> | null | undefined): string | null {
  if (outcome === null || outcome === undefined) return null;
  const type = outcome.type;
  return typeof type === "string" && type !== "" ? type : null;
}

/**
 * L'etichetta da affiancare allo stato, o `null` se non c'è niente da dire.
 *
 * `null` in tre casi, tutti normali: nessun esito (chiusa per mancanza di
 * segnale — il caso più comune), un esito senza `type` leggibile, e un `type`
 * che questa mappa non conosce (vedi il ⚠️ del modulo: succede sui dati veri).
 */
export function closedReason(
  outcome: Record<string, unknown> | null | undefined,
): ClosedReason | null {
  const type = outcomeType(outcome);
  if (type === null) return null;
  return REASONS[type] ?? null;
}

/**
 * L'id del progetto di destinazione di una riattribuzione, se c'è.
 *
 * ⚠️ **Torna un ID, non un nome, e chi rende NON deve mostrarlo.** Serve a
 * cercare il nome nell'elenco progetti: se non si risolve (progetto cancellato,
 * elenco non ancora caricato) l'etichetta va scritta nella sua forma SENZA
 * nome. Un UUID a schermo non dice niente a nessuno, ed è il genere di
 * dettaglio che in un test con dati finti non emerge mai.
 */
export function closedReasonProjectId(
  outcome: Record<string, unknown> | null | undefined,
): string | null {
  if (outcome === null || outcome === undefined) return null;
  const projectId = outcome.projectId;
  return typeof projectId === "string" && projectId !== "" ? projectId : null;
}
