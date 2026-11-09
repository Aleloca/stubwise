import type {
  ColleaguePrMode,
  OpenPullRequest,
  PrAnalysis,
  PrAutoCorrection,
} from "../../data/model";
import type { CorrectionRecord } from "../claude/taskWork";

// Lo stato di una PR e se Claude può correggerla: UN motore per tutte (spec
// «PR», scelta E). Le PR di Stubwise arrivano con le correzioni lette dalle
// sessioni della task (`correctionsFromRecords`), quelle dei colleghi con le
// loro `corrections`; cambiano solo l'autore e le regole dei rami vietati.
// Il tetto è UNO, il `correctionCap` del progetto (R-K2): nessuna costante a
// parte. Le correzioni scartate (l'autore ha spinto in parallelo) non
// contano; i commit dell'autore non azzerano il conto. Oltre il tetto va
// solo chi ha `plans.approve`: questa funzione dice solo che l'automatica
// non parte.

/** Il tetto delle correzioni quando il progetto non fissa un `correctionCap` (R-K2): l'unica copia. */
export const DEFAULT_CORRECTION_CAP = 3;

export type PrStateKind =
  | "analyzing"
  | "clean"
  | "issues"
  | "correcting"
  | "corrected"
  | "discarded"
  | "capped"
  | "analysis_only"
  | "analysis_off"
  | "not_fixable";

export type NotFixableReason =
  | "fork"
  | "protected"
  | "default_branch"
  | "release_branch"
  | "target_branch"
  | "other_task_branch";

export interface PrCorrectionInput {
  trigger: PrAutoCorrection["trigger"];
  state: PrAutoCorrection["state"];
}

export interface PrStateInput {
  origin: OpenPullRequest["origin"];
  /** La testa della PR adesso: un'analisi su un'altra testa vale come «in analisi» (R-K9). */
  headSha: string;
  analysis: PrAnalysis | null;
  corrections: PrCorrectionInput[];
  /** Il `correctionCap` del progetto. */
  cap: number;
  /** Vale solo per `origin: "colleague"`. */
  repoMode: ColleaguePrMode;
  /** «Solo analisi» acceso sulla singola PR. */
  prAnalysisOnly: boolean;
  branch: string;
  baseBranch: string;
  /** Il ramo di default sulla piattaforma (R-K20): vietato anche se non è quello di rilascio. */
  defaultBranch: string;
  /** Il ramo di rilascio del repository: vietato anche se la PR punta altrove. */
  releaseBranch: string;
  fromFork: boolean;
  branchProtected: boolean;
  /** Il codice della task collegata alla PR (`STW-3`): il suo ramo `stubwise/…` non è vietato. */
  ownTaskCode: string | null;
}

export interface PrState {
  state: PrStateKind;
  /** Presente quando il ramo è vietato, anche se non ci sono problemi da correggere. */
  notFixable?: NotFixableReason;
  /** I giri che contano nel tetto (R-K8): le correzioni `pushed` o `running`, automatiche o chieste. */
  autoRound: number;
  /** Una correzione automatica può partire adesso. */
  canAutoCorrect: boolean;
}

/** Perché Claude non può spingere su questo ramo (anti-obiettivo 4), o `null`. */
function forbiddenBranch(i: PrStateInput): NotFixableReason | null {
  if (i.fromFork) return "fork";
  if (i.branchProtected) return "protected";
  if (i.branch === i.defaultBranch) return "default_branch";
  if (i.branch === i.releaseBranch) return "release_branch";
  if (i.branch === i.baseBranch) return "target_branch";
  if (i.branch.startsWith("stubwise/")) {
    const own = i.ownTaskCode ? `stubwise/${i.ownTaskCode}` : null;
    const mine = own !== null && (i.branch === own || i.branch.startsWith(`${own}-`));
    if (!mine) return "other_task_branch";
  }
  return null;
}

/**
 * Il giro di una PR, l'UNICO conteggio del tetto (R-K2, R-K8): contano solo
 * le correzioni che hanno fatto, o stanno facendo, un commit; le fermate
 * prima del push (fallite, finite senza invio) e le scartate no. Lo usano
 * `prState` (Rilasci) e `prCycles` (pagina della task), e le porte che
 * aprono una correzione passano da qui.
 */
export const countedRound = (corrections: readonly PrCorrectionInput[]): number =>
  corrections.filter((c) => c.state === "pushed" || c.state === "running").length;

export function prState(i: PrStateInput): PrState {
  const autoRound = countedRound(i.corrections);
  const notFixable = forbiddenBranch(i);
  const out = (state: PrStateKind, canAutoCorrect = false): PrState => ({
    state,
    ...(notFixable ? { notFixable } : {}),
    autoRound,
    canAutoCorrect,
  });

  const colleague = i.origin === "colleague";
  // «Spento» vince su tutto: una PR non lo riaccende.
  if (colleague && i.repoMode === "off") return out("analysis_off");
  const analysisOnly = i.prAnalysisOnly || (colleague && i.repoMode === "analyze_only");
  // Con «Solo analisi» una correzione in volo si ferma prima del push.
  if (i.corrections.some((c) => c.state === "running")) {
    return out(analysisOnly ? "analysis_only" : "correcting");
  }
  // R-K9: l'analisi si rifà a ogni commit nuovo; una su un'altra testa è stantia.
  if (!i.analysis || i.analysis.status === "running" || i.analysis.sha !== i.headSha) {
    return out("analyzing");
  }
  if (i.analysis.issues.length === 0) {
    // «Corretta da Claude»: l'ultima correzione che ha toccato la testa (le
    // fermate prima del push non la toccano) è un push di Claude. Dopo uno
    // scarto la testa pulita è dell'autore: è solo «senza problemi».
    const lastTouch = i.corrections.filter((c) => c.state !== "stopped").at(-1);
    return out(lastTouch?.state === "pushed" ? "corrected" : "clean");
  }
  // Ci sono problemi aperti: chi li può correggere?
  if (notFixable) return out("not_fixable");
  if (analysisOnly) return out("analysis_only");
  if (autoRound >= i.cap) return out("capped");
  return out(i.corrections.at(-1)?.state === "discarded" ? "discarded" : "issues", true);
}

/**
 * Le correzioni di una PR di Stubwise, dalle sessioni della task
 * (`correctionsOf`): solo quelle della PR `prKey` (`owner/repo#n`). Le
 * annullate (fermate in una sessione poi chiusa) non ci sono, come in
 * `prCycles`: non contano e non sono «scartate» (nessun push dell'autore);
 * in corso e in pausa sono in volo; fallita o finita senza invio sono
 * ferme. Il ciclo di Stubwise nasce dalla review: tutte automatiche.
 */
export function correctionsFromRecords(
  records: readonly CorrectionRecord[],
  prKey: string,
): PrCorrectionInput[] {
  return records
    .filter((r) => r.pr === prKey && !r.cancelled)
    .map((r): PrCorrectionInput => {
      if (r.state === "running" || r.state === "paused")
        return { trigger: "auto", state: "running" };
      if (r.state === "pushed") return { trigger: "auto", state: "pushed" };
      return { trigger: "auto", state: "stopped" };
    });
}

/** Gli stati che dicono «ci sono ancora problemi aperti» (R-K4). */
const OPEN_PROBLEMS: ReadonlySet<PrStateKind> = new Set([
  "analyzing",
  "issues",
  "correcting",
  "capped",
]);

/**
 * «Pronta per il rilascio» (R-K4, R-K7): aperta, controlli verdi, mergeable
 * E senza problemi aperti — né per lo stato della PR, né nell'ultima analisi.
 * Vale per ogni PR: anche una non correggibile o in «Solo analisi» con
 * problemi non è pronta, e un problema si chiude solo con una nuova analisi
 * pulita sulla nuova testa. `stubwise/guide#58` del seme (al tetto) e
 * `audin/audin-app#209` (dal fork, con un problema) non sono pronte.
 */
export function isReadyForRelease(
  pr: Pick<OpenPullRequest, "state" | "checks" | "mergeable" | "analysis">,
  state: Pick<PrState, "state">,
): boolean {
  return (
    pr.state === "open" &&
    pr.checks === "passing" &&
    pr.mergeable &&
    !OPEN_PROBLEMS.has(state.state) &&
    (pr.analysis?.issues.length ?? 0) === 0
  );
}
