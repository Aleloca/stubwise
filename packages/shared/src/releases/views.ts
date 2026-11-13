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
