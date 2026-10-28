import type { TFunction } from "i18next";
import { shortRepo } from "../../domain/releases/repo";
import { now } from "../../data/dates";
import type { OpenPrView, ReleaseView, RunView } from "../../data/releases";
import { formatDate } from "../../notifications/time";

// Le parole della sezione Releases (shape releases.md §5 e §8): stati di PR e
// rilasci, motivi, tempi. Tutto da template i18n e dai dati già derivati dal
// livello dati (`prState`, `releaseStatus`): qui non si ricalcola nessuno
// stato. Solo riassunto e problemi dell'analisi sono testo di Claude.

/** «audin-app» da «audin/audin-app». */
export { shortRepo };

/** «audin-app#246»: il codice di una PR nelle righe. */
export const prCode = (pr: { repo: string; number: number }): string =>
  `${shortRepo(pr.repo)}#${pr.number}`;

/** La piattaforma di un indirizzo (il nome nei link e negli errori). */
export function platformOf(url: string | null | undefined): string {
  return url && /bitbucket/i.test(url) ? "Bitbucket" : "GitHub";
}

/** L'indirizzo di una PR sulla piattaforma. */
export const prUrl = (pr: { repo: string; number: number }): string =>
  `https://github.com/${pr.repo}/pull/${pr.number}`;

/** Lo sha corto, come lo scrive git. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

/** «2 h ago», «Yesterday», «3 d ago», poi la data: rispetto a `now()` dello store. */
export function ago(iso: string, t: TFunction, language: string): string {
  const minutes = Math.floor((Date.parse(now()) - Date.parse(iso)) / 60_000);
  if (minutes < 1) return t("notifications.time.now");
  if (minutes < 60) return t("notifications.time.minutes", { n: minutes });
  if (minutes < 24 * 60) return t("notifications.time.hours", { n: Math.floor(minutes / 60) });
  const days = Math.floor(minutes / (24 * 60));
  if (days === 1) return t("notifications.time.yesterday");
  if (days < 7) return t("notifications.time.days", { n: days });
  return formatDate(iso, language);
}

/** «14:05» (UTC, come il resto del prototipo). */
export function clock(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(iso));
}

/** La durata di una run: «4 min 12 s»; in corso, fino a `now()`. */
export function duration(run: RunView, t: TFunction): string {
  const end = run.endedAt ?? now();
  const s = Math.max(0, Math.round((Date.parse(end) - Date.parse(run.startedAt)) / 1000));
  const m = Math.floor(s / 60);
  return m > 0
    ? t("releases.run.duration", { m, s: s % 60 })
    : t("releases.run.durationSeconds", { s });
}

/** La parola di stato di una PR, in elenco e nei nomi accessibili. */
export function prStateWord(pr: OpenPrView, t: TFunction): string {
  const kind = pr.prState.state;
  if (kind === "issues")
    return t("releases.prState.issues", { count: pr.analysis?.issues.length ?? 0 });
  return t(`releases.prState.${kind}`);
}

/** Il rischio in parola, se c'è un'analisi che si mostra. */
export function riskWord(pr: OpenPrView, t: TFunction): string | null {
  if (!pr.analysis || pr.prState.state === "analysis_off" || pr.prState.state === "analyzing") {
    return null;
  }
  return t(`releases.risk.${pr.analysis.risk}`);
}

/**
 * Perché una PR non è pronta, dai fatti già letti (mai una stima): la prima
 * voce della seconda riga nel gruppo «Non ancora pronte».
 */
export function notReadyReason(pr: OpenPrView, t: TFunction): string | null {
  if (pr.checks === "failing") return t("releases.reason.checksFailing");
  if (pr.checks === "pending") return t("releases.reason.checksRunning");
  if (pr.checks === "unreadable") return t("releases.reason.checksUnreadable");
  if (!pr.mergeable) return t("releases.reason.conflicts", { branch: pr.baseBranch });
  return null;
}

/** La prosa della seconda riga dopo stato e rischio (shape §5, «Seconda riga»). */
export function prProse(pr: OpenPrView, t: TFunction): string | null {
  const { cap } = pr;
  const s = pr.prState;
  switch (s.state) {
    case "analyzing":
      return t("releases.prLine.analyzing");
    case "issues":
      return pr.analysisOnly ? t("releases.prLine.analysisOnly") : t("releases.prLine.willFix");
    case "correcting":
      return t("releases.prLine.correcting", { n: Math.max(1, s.autoRound), cap });
    case "corrected": {
      const pushed = [...pr.corrections].reverse().find((c) => c.state === "pushed");
      return pushed?.commitSha
        ? t("releases.prLine.corrected", { sha: shortSha(pushed.commitSha) })
        : t("releases.prLine.correctedNoSha");
    }
    case "discarded":
      return t("releases.prLine.discarded", { name: pr.authorName });
    case "capped":
      return t("releases.prLine.capped", { cap });
    case "analysis_only":
      return t("releases.prLine.analysisOnly");
    case "analysis_off":
      return t("releases.prLine.analysisOff", { repo: shortRepo(pr.repo) });
    case "not_fixable":
      return t(`releases.notFixable.${s.notFixable ?? "fork"}`);
    case "clean":
      return null;
  }
}

/** I controlli in parola. */
export const checksWord = (pr: OpenPrView, t: TFunction): string =>
  t(`releases.checks.${pr.checks}`);

/** Lo stato di un rilascio in parola (in lista e nel dettaglio). */
export const releaseWord = (r: ReleaseView, t: TFunction): string =>
  t(`releases.status.${r.status.kind}`);

/** La run che ha fatto fallire il rilascio (la prima fallita). */
export const failedRun = (r: ReleaseView): RunView | undefined =>
  r.runs.find((x) => x.status === "failed");

/** «Failed at “Run migrations” in “Deploy to production”» e le altre frasi di «Now». */
export function nowSentence(r: ReleaseView, t: TFunction, language: string): string {
  const s = r.status;
  switch (s.kind) {
    case "failed": {
      const run = failedRun(r);
      return run?.failedStep
        ? t("releases.now.failedAt", { step: run.failedStep, run: run.name })
        : t("releases.now.failedIn", { run: run?.name ?? "" });
    }
    case "running": {
      const running = r.runs.filter((x) => x.status === "running");
      if (r.runs.length === 0) {
        return t("releases.now.waiting", { ago: ago(r.mergedAt, t, language) });
      }
      return t("releases.now.running", {
        count: r.runs.length,
        running: running.length,
        name: running[0]?.name ?? "",
      });
    }
    case "succeeded":
      return t("releases.now.succeeded", {
        count: r.runs.length,
        time: s.since ? clock(s.since, language) : "",
      });
    case "not_in_production":
      return t("releases.now.notInProduction");
    case "in_production":
      return t("releases.now.inProduction", { time: s.since ? clock(s.since, language) : "" });
    case "unavailable":
      return t(`releases.now.unavailable.${s.reason ?? "no_production_env"}`, {
        code: r.projectCode,
      });
  }
}

/** Chi ha fatto il merge: persona, o l'identità git non collegata, e se fuori da Stubwise. */
export function mergedBy(
  r: ReleaseView,
  t: TFunction,
  person: (id: string | null) => string | null,
): string {
  const name = person(r.mergedById);
  if (r.viaStubwise) return name ?? r.mergedGitName;
  return name
    ? t("releases.list.outsideBy", { name })
    : t("releases.list.outsideUnlinked", { login: r.mergedGitName });
}
