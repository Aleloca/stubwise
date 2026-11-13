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
  permissions: {
    /** Mettere o togliere «Solo analisi» (una PR di un collega, `prs.adopt`). */
    analysisOnly: boolean;
    /** «Chiedi modifiche»: `corrections.request` su una PR di Stubwise, `prs.adopt` su quella di un collega. */
    requestCorrection: boolean;
    /** Scrivere le note della PR: `release.merge` o `tickets.edit` nel progetto. */
    editReleaseNotes: boolean;
  };
}
