import type { ColleaguePrMode, OpenPrState } from "./pr-state.js";
import type { ReleaseStatus } from "./status.js";

/**
 * LE FORME DEI RILASCI verso i client (area 8, F1). Calcolate dal server
 * (stato derivato, permessi): il client le legge, non le deduce. I campi che
 * arriveranno dopo nascono facoltativi.
 */

/** Una run di CI del commit di merge, come l'ha letta il provider. Il log sta sul provider (P-1 = a): `url`. */
export interface ReleaseRun {
  id: string;
  name: string;
  status: "running" | "success" | "failed";
  url: string | null;
  failedStep: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

/** Una riga dell'elenco dei rilasci di un progetto. */
export interface ReleaseRow {
  id: string;
  /** `<PRJ>-V<n>`. */
  code: string;
  projectId: string;
  repositoryId: string;
  repositoryName: string;
  /** `owner/repo`, dall'indirizzo del repository (per «audin-app#246» o il link). Assente da un server più vecchio. */
  repositoryFullName?: string;
  prNumber: number | null;
  prUrl: string;
  /** Il titolo della PR (o della task, per un merge da Stubwise). */
  title: string;
  mergeSha: string;
  mergedAt: string;
  /** La persona che ha fatto il merge, se collegata. */
  mergedById: string | null;
  /** Il nome git di chi ha fatto il merge sul provider, se si sa. */
  mergedGitName: string | null;
  viaStubwise: boolean;
  /** Lo stato DERIVATO (`releaseStatusOf`), mai salvato. */
  status: ReleaseStatus;
  /** La task di «Fai sistemare a Claude», se c'è e chi guarda la vede; `open` = non ancora chiusa. */
  fixTask: { id: string; code: string; title?: string; open?: boolean } | null;
  /**
   * Calcolati dal server per chi guarda. `fix`: rilascio fallito, nessuna task
   * di riparazione APERTA, e `tickets.create`; `startFix`: in più `runs.start`
   * e il budget del mese non esaurito. Assente da un server più vecchio.
   */
  permissions?: { fix: boolean; startFix?: boolean };
  /** Fallito, nessuna task di riparazione aperta, e il merge l'ha fatto chi guarda ([R 6]). */
  waitsOnViewer?: boolean;
}

/** `GET /api/releases/:code`: il rilascio intero. */
export interface ReleaseDetail extends ReleaseRow {
  runs: ReleaseRun[];
  /** Le note della PR fermate al merge. */
  releaseNotes: string | null;
  seenInProductionAt: string | null;
  permissions: { fix: boolean; startFix?: boolean };
  /** La task della PR, se chi guarda la vede (`<PRJ>-<n>`). */
  relatedTaskCode?: string | null;
  /** Perché Claude non può partire con la task (il budget del mese); null = può. */
  fixBlock?: { reason: "monthly_budget" } | null;
  /** Il server della repository nell'ambiente di produzione e il commit che riporta (R-L2). */
  productionServer?: { serverId: string; serverName: string; reportedSha: string | null } | null;
}

/** `POST /api/releases/:code/fix`: la task (nuova o già aperta), se la nota è entrata, se Claude è partito. */
export interface ReleaseFixResult {
  taskId: string;
  taskCode: string;
  /** La task di riparazione c'era già (aperta): niente task nuova. */
  existing: boolean;
  /** La nota è entrata (nella task nuova, o come commento su quella già aperta con `tickets.comment`). */
  noteAdded: boolean;
  /** Claude è partito sulla task (chiesto, con `runs.start` e il budget). */
  started: boolean;
}

/**
 * `GET /api/projects/:projectId/pulls` (area 8, F1, S5b): una PR aperta di un
 * repository del progetto, per CHIUNQUE veda il progetto. La voce della coda
 * (`ReleaseQueueItem`, stessa deduplica) più ciò che l'elenco del prototipo
 * mostra; i permessi per chi guarda li calcola il server. Il merge e
 * `canMerge` restano della coda (`/api/release-queue`, `release.merge`).
 */
export interface OpenPull {
  /** Il progetto della PR (serve dove le PR di più progetti stanno insieme, come la Home). */
  projectId?: string;
  projectCode?: string;
  origin: "stubwise" | "external";
  ticketId: string;
  ticketNumber: number;
  ticketTitle: string;
  repositoryId: string;
  repositoryName: string;
  branch: string;
  /** Il ramo su cui la PR andrà (null se non si sa). */
  baseBranch: string | null;
  prUrl: string;
  prNumber: number | null;
  headSha: string | null;
  createdAt: string;
  /** I controlli della PR come li legge la coda (`passing` ecc. li traduce il client). */
  checks: { status: string; checks: { name: string; status: string }[] };
  /** Gli ambienti il cui agente riporta già la head di questa PR. */
  deployedOn: string[];
  analysis: { verdict: string | null; summary: string | null; stale: boolean };
  /** Le correzioni chieste su questa PR (non annullate) e lo stato dell'ultima. */
  corrections: { count: number; lastStatus: string | null };
  /** Il tetto dei giri automatici del progetto. */
  cap: number;
  /** «Solo analisi» su questa PR: chi e quando; null = no. */
  analysisOnly: { byId: string | null; at: string } | null;
  /**
   * Area 8, F1, S8: lo stato della PR (`prStateOf` di shared, calcolato dal
   * server) e se è pronta per il rilascio (`isReadyForRelease`; `mergeable`
   * non letto non blocca). Facoltativi: un server di prima non li manda.
   */
  /** `analysis_off` anche quando la review automatica dell'istanza è spenta e la PR non ha analisi: «non analizzata», non «senza problemi» ((O) di 46); può essere `ready`. */
  prState?: OpenPrState;
  ready?: boolean;
  /** La PR viene da un fork (null = il provider non lo dice). */
  fromFork?: boolean | null;
  /** Non letto nella F1: sempre null. */
  mergeable?: boolean | null;
  /** L'impostazione delle PR dei colleghi del repository. */
  colleaguePrs?: ColleaguePrMode;
  /**
   * I problemi aperti dell'ultima analisi sulla head. Senza problemi
   * strutturati: con «chiede modifiche», un elemento col riassunto (per non
   * dire «senza problemi»); vuoto se approva.
   */
  issues?: { title: string; file: string | null }[];
  /**
   * La storia delle correzioni della PR, dalla più vecchia (le annullate no):
   * `pushed` = il suo job ha pushato, `running` = in coda o in corso,
   * `stopped` = finita senza push (`why`: l'errore del job). `commitSha` non
   * si legge nella F1 (null); `discarded` non si deriva ancora (registro).
   */
  correctionHistory?: {
    id: string;
    trigger: "auto" | "person";
    byId: string | null;
    state: "running" | "pushed" | "discarded" | "stopped";
    commitSha: string | null;
    why: string | null;
    at: string;
  }[];
  /** Un ambiente `staging` del progetto riporta la head della PR. */
  onStaging?: boolean;
  /** `owner/repo` del repository, come nelle righe dei rilasci. */
  repositoryFullName?: string;
  /** Le note di rilascio salvate della PR (`pr_release_notes`); null se nessuno le ha scritte. La bozza è in `…/release-notes`. */
  releaseNotes?: string | null;
  permissions: {
    /** Mettere o togliere «Solo analisi» (una PR di un collega, `prs.adopt`). */
    analysisOnly: boolean;
    /** «Chiedi modifiche»: `corrections.request` su una PR di Stubwise, `prs.adopt` su quella di un collega. */
    requestCorrection: boolean;
    /** Scrivere le note della PR: `release.merge` o `tickets.edit` nel progetto. */
    editReleaseNotes: boolean;
  };
}

/**
 * Le note di rilascio di una PR (area 8, F1, S9): il testo salvato (null se
 * nessuno l'ha scritto), la bozza CALCOLATA (una riga per task, dalla task
 * della PR e dai commit che citano un codice; nessun modello) e se chi guarda
 * le può scrivere. `commitsRead: false` = i commit non si sono potuti leggere
 * dal provider: la bozza viene dalla sola task della PR.
 */
export interface PrReleaseNotes {
  repositoryId: string;
  prNumber: number;
  body: string | null;
  updatedById: string | null;
  updatedAt: string | null;
  draft: { text: string; sources: string[] };
  commitsRead: boolean;
  canEdit: boolean;
}

/**
 * Il blocco «Rilasci» della Home (area 8, F1, S10), di chi ha `release.merge`
 * in qualche progetto: i rilasci FALLITI dei suoi progetti finché la loro
 * task di riparazione non si chiude (uno in riparazione resta), dal più
 * recente; poi le PR PRONTE per il rilascio (`ready`). Nella F2 «falliti che
 * mi riguardano» si allarga agli iscritti all'avviso (catalogo).
 */
export interface MyReleases {
  failed: ReleaseRow[];
  ready: OpenPull[];
}
