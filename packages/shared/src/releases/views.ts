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
  /** La task di «Fai sistemare a Claude», se c'è e chi guarda la vede. */
  fixTask: { id: string; code: string } | null;
}

/** `GET /api/releases/:code`: il rilascio intero. */
export interface ReleaseDetail extends ReleaseRow {
  runs: ReleaseRun[];
  /** Le note della PR fermate al merge. */
  releaseNotes: string | null;
  seenInProductionAt: string | null;
  permissions: {
    /** «Fai sistemare a Claude»: rilascio fallito, nessuna task ancora, e chi guarda ha `tickets.create`. */
    fix: boolean;
  };
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
  permissions: {
    /** Mettere o togliere «Solo analisi» (una PR di un collega, `prs.adopt`). */
    analysisOnly: boolean;
    /** «Chiedi modifiche»: `corrections.request` su una PR di Stubwise, `prs.adopt` su quella di un collega. */
    requestCorrection: boolean;
    /** Scrivere le note della PR: `release.merge` o `tickets.edit` nel progetto. */
    editReleaseNotes: boolean;
  };
}
