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
 * ⚠️ **E COPRE SOLO GLI ESITI SCRITTI SU `email_proposals`** — la tabella che
 * l'unico chiamante legge. Non è un dettaglio: la prima stesura mappava
 * `superseded_in_thread`, `triage_dismissed` e `declined`, che vivono su
 * ALTRE tabelle e quindi non arrivavano mai qui, mentre il caso davvero
 * frequente — `superseded_by_message` — non era mappato. Una mappa con chiavi
 * irraggiungibili è peggio di una incompleta: fa credere a chi legge che quei
 * casi siano coperti. Vedi {@link OUTCOMES_ON_OTHER_TABLES}, che li nomina
 * apposta, e il test che impedisce a una chiave di rientrare qui per sbaglio.
 */

/** La chiave i18n di un esito, e cosa deve sapere chi lo rende. */
export interface ClosedReason {
  /** Chiave i18n dell'etichetta (`closedReason.*`). */
  key: string;
  /**
   * `true` quando l'etichetta ha due forme — con e senza il nome del progetto
   * — e chi rende deve scegliere. Vedi {@link closedReasonProjectId}.
   */
  needsProject: boolean;
  /**
   * ⚠️ `true` **solo** per la riattribuzione fallita: è l'unico esito che
   * segnala un GUASTO e non una scelta, ed è l'unico su cui «Riproponi» è la
   * risposta giusta.
   *
   * Sta QUI e non si deduce confrontando `key` con una stringa: le chiavi i18n
   * in questo repo si rinominano, e un rename spegnerebbe **in silenzio**
   * l'unica distinzione che il client fa — chi legge «ignorata» su un guasto
   * non riprova.
   */
  failed: boolean;
}

/**
 * Gli esiti che questa funzione sa spiegare.
 *
 * Un oggetto e non un `Record` tipato su un'unione: quei valori non sono un
 * enum da nessuna parte — vivono in un jsonb — e fingere che lo siano è ciò
 * che renderebbe questa mappa esaustiva per errore.
 *
 * Ogni voce nomina DOVE viene scritta, perché è l'unica difesa contro il
 * difetto che questa mappa ha già avuto: una chiave che sembra coperta e non
 * arriva mai.
 */
const REASONS: Record<string, ClosedReason> = {
  /** `google-proposal.ts`, case `reassign_project` → `email_proposals`. */
  reassigned_to: { key: "closedReason.reassignedTo", needsProject: true, failed: false },
  /** `classify.ts`, `closeReassigned` → `email_proposals`. */
  reassign_failed: { key: "closedReason.reassignFailed", needsProject: false, failed: true },
  /** `classify.ts`, `closeReassigned` → `email_proposals`. */
  reassign_no_signal: { key: "closedReason.reassignNoSignal", needsProject: false, failed: false },
  /** `classify.ts`, `closeReassigned` → `email_proposals`. */
  reassign_target_gone: {
    key: "closedReason.reassignTargetGone",
    needsProject: false,
    failed: false,
  },
  /**
   * `classify.ts` → `email_proposals`: la proposta aperta è stata sostituita
   * da un messaggio successivo dello stesso thread. **È il caso più frequente
   * di una conversazione con più messaggi**, cioè esattamente ciò per cui
   * esiste la serie «la posta si legge per conversazione» — e nella prima
   * stesura era l'unico che mancava.
   */
  superseded_by_message: {
    key: "closedReason.supersededByMessage",
    needsProject: false,
    failed: false,
  },
};

/**
 * Gli esiti di una proposta ANDATA A BUON FINE, deliberatamente non spiegati.
 *
 * Per queste card l'etichetta di stato «Eseguita» dice già ciò che serve: un
 * perché in più sarebbe rumore. Sono elencati — invece di essere semplicemente
 * omessi — perché è così che il test può dire «ogni esito che finisce su
 * `email_proposals` o è spiegato, o è escluso di proposito»: un esito NUOVO
 * che non stia in nessuno dei due insiemi è una svista, non una scelta.
 */
export const SUCCESSFUL_PROPOSAL_OUTCOMES = [
  "backlog_item",
  "milestone",
  "exists",
  "ticket_updated",
  "commented",
  "decision_recorded",
  "reassigned_project",
  "reminder",
  "ignored",
] as const;

/**
 * ⚠️ Esiti che esistono ma **NON finiscono su `email_proposals`**, e quindi
 * non vanno in {@link REASONS} anche se sembrano appartenere a questa
 * famiglia.
 *
 * Nominati invece che taciuti perché tacerli è esattamente come è nato il
 * difetto: qualcuno li ha visti in un elenco di «esiti di una proposta
 * chiusa» e li ha mappati, e per settimane la mappa ha promesso casi che non
 * arrivavano mai. Chi vorrà spiegarli dovrà prima portarli dove questa
 * funzione li possa vedere, o leggerli da un'altra tabella.
 *
 *  - `superseded_in_thread` → `email_messages` (`classify.ts`): è il MESSAGGIO
 *    superato, non la proposta;
 *  - `triage_dismissed` → `email_messages` (`google-proposal.ts`): uno
 *    smistamento vive sul padre e per costruzione non ha figli;
 *  - `declined` → `calendar_events` (`calendar.ts`): il calendario, che in una
 *    conversazione di posta non compare mai.
 */
export const OUTCOMES_ON_OTHER_TABLES = [
  "superseded_in_thread",
  "triage_dismissed",
  "declined",
] as const;

/** Tutto ciò che può finire su `email_proposals.outcome` scritto dal codice. */
export const PROPOSAL_OUTCOME_TYPES: readonly string[] = [
  ...Object.keys(REASONS),
  ...SUCCESSFUL_PROPOSAL_OUTCOMES,
];

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
 * `null` in quattro casi, tutti normali: nessun esito (chiusa per mancanza di
 * segnale — il più comune), un esito senza `type` leggibile, un esito di una
 * card andata a buon fine ({@link SUCCESSFUL_PROPOSAL_OUTCOMES}) e un `type`
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
