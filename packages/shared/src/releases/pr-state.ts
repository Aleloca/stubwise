import { countedRound, type PrCorrectionInput } from "../claude/pr-corrections.js";
import { isProtectedBranch } from "../protected-branches.js";

// Lo stato di una PR e se Claude può correggerla: UN motore per tutte (area
// 8, F1; era `domain/releases/prState.ts` del prototipo, spec «PR», scelta
// E), per prototipo, server e worker. Le PR di Stubwise arrivano con le
// correzioni lette dalle sessioni della task, quelle dei colleghi con le
// loro; cambiano solo l'autore e le regole dei rami vietati. Il tetto è UNO,
// il `correctionCap` del progetto (R-K2). Le correzioni scartate (l'autore
// ha spinto in parallelo) non contano; i commit dell'autore non azzerano il
// conto. Oltre il tetto va solo chi ha `plans.approve`: questa funzione dice
// solo che l'automatica non parte.

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

/** La modalità delle PR dei colleghi di un repository. */
export type ColleaguePrMode = "analyze_and_fix" | "analyze_only" | "off";

/** L'analisi di una PR come la legge lo stato. */
export interface PrAnalysisLike {
  /** La testa analizzata. */
  sha: string;
  status: "running" | "done";
  issues: readonly { title: string; file: string | null }[];
}

/** I fatti del ramo che decidono se Claude ci può spingere (anti-obiettivo 4). */
export interface PrBranchInput {
  branch: string;
  baseBranch: string;
  /** Il ramo di default sulla piattaforma (R-K20): vietato anche se non è quello di rilascio. */
  defaultBranch: string;
  /** Il ramo di rilascio del repository: vietato anche se la PR punta altrove. */
  releaseBranch: string;
  fromFork: boolean;
  /** Protetto secondo la piattaforma. */
  branchProtected: boolean;
  /** I pattern dei rami protetti dell'istanza o del repository (`isProtectedBranch`), se ci sono. */
  protectedPatterns?: readonly string[];
  /** Il codice della task collegata alla PR (`STW-3`): il suo ramo `stubwise/…` non è vietato. */
  ownTaskCode: string | null;
}

export interface PrStateInput extends PrBranchInput {
  /** `external` (il server) vale come `colleague` (il prototipo). */
  origin: "stubwise" | "colleague" | "external";
  /** La testa della PR adesso: un'analisi su un'altra testa vale come «in analisi» (R-K9). */
  headSha: string;
  analysis: PrAnalysisLike | null;
  corrections: readonly PrCorrectionInput[];
  /** Il `correctionCap` del progetto. */
  cap: number;
  /** Vale solo per le PR dei colleghi. */
  repoMode: ColleaguePrMode;
  /** «Solo analisi» acceso sulla singola PR. */
  prAnalysisOnly: boolean;
}

export interface OpenPrState {
  state: PrStateKind;
  /** Presente quando il ramo è vietato, anche se non ci sono problemi da correggere. */
  notFixable?: NotFixableReason;
  /** I giri che contano nel tetto (R-K8): le correzioni `pushed` o `running`, automatiche o chieste. */
  autoRound: number;
  /** Una correzione automatica può partire adesso. */
  canAutoCorrect: boolean;
}

/**
 * Perché Claude non può spingere su questo ramo, o `null`: l'invariante «Le
 * PR dei colleghi» in UN posto (lo stato, il worker, `enqueueCorrection`).
 * Fork, protetto (piattaforma o pattern), default, rilascio, target, e un
 * `stubwise/…` che non è della task della PR.
 */
export function colleaguePrBlock(i: PrBranchInput): NotFixableReason | null {
  if (i.fromFork) return "fork";
  if (
    i.branchProtected ||
    (i.protectedPatterns && isProtectedBranch(i.branch, i.protectedPatterns))
  ) {
    return "protected";
  }
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

export function prStateOf(i: PrStateInput): OpenPrState {
  const autoRound = countedRound(i.corrections);
  const notFixable = colleaguePrBlock(i);
  const out = (state: PrStateKind, canAutoCorrect = false): OpenPrState => ({
    state,
    ...(notFixable ? { notFixable } : {}),
    autoRound,
    canAutoCorrect,
  });

  const colleague = i.origin !== "stubwise";
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
 * `mergeable: null` (non letto, F1 del server) non blocca: se la piattaforma
 * rifiuta, lo dice il merge (`not_mergeable`).
 */
export function isReadyForRelease(
  pr: {
    state: "open" | "merged" | "closed";
    checks: "passing" | "failing" | "pending" | "unreadable";
    mergeable: boolean | null;
    analysis: { issues: readonly unknown[] } | null;
  },
  state: Pick<OpenPrState, "state">,
): boolean {
  return (
    pr.state === "open" &&
    pr.checks === "passing" &&
    pr.mergeable !== false &&
    !OPEN_PROBLEMS.has(state.state) &&
    (pr.analysis?.issues.length ?? 0) === 0
  );
}
