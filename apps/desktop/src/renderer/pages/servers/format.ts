import type { TFunction } from "i18next";
import { now } from "../../data/dates";
import type { ServerRow } from "../../data/servers";
import type { EpisodeReason, ServerCheck } from "../../data/types";
import { ago } from "../releases/format";

// Le parole della sezione Servers (shape servers.md §3): salute, motivi,
// lavoro, accesso, ambienti, durate. Tutto da template i18n e dagli stati
// già derivati dal livello dati (`health`, `work`, `access`,
// `analysisProject`): qui non si ricalcola nessuno stato.
//
// Le ore di un server sono nel fuso di CHI GUARDA (decisione del controller
// per l'ora del rientro, estesa a tutta la pagina perché una pagina con due
// fusi si leggerebbe male); nei test il fuso è UTC (`vitest.config.ts`).

export { ago };

/** «14:02», nel fuso di chi guarda. */
export function clockLocal(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/** «Oct 27», nel fuso di chi guarda. */
export function dayLocal(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, { month: "short", day: "numeric" }).format(
    new Date(iso),
  );
}

const localDay = (iso: string) => new Date(iso).toDateString();

/** Lo stesso giorno di adesso (nel fuso di chi guarda)? */
export const isToday = (iso: string): boolean => localDay(iso) === localDay(now());

/** Il suffisso delle chiavi con una data invece di un'ora («since Oct 27» / «dal 27 ott»). */
export const dayKey = (iso: string): "" | "Day" => (isToday(iso) ? "" : "Day");

/** «09:40» oggi, «Oct 27» prima: il «da quando» di una riga. */
export function sinceWhen(iso: string, language: string): string {
  return isToday(iso) ? clockLocal(iso, language) : dayLocal(iso, language);
}

/** «2 h 8 min», «12 min», «less than a minute». */
export function duration(ms: number, t: TFunction): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return t("servers.duration.lessThanMinute");
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return t("servers.duration.minutes", { m });
  return m === 0
    ? t("servers.duration.hours", { h })
    : t("servers.duration.hoursMinutes", { h, m });
}

/** «30 s ago» sotto il minuto, poi come il resto dell'app. */
export function lastReport(iso: string, t: TFunction, language: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(now()) - Date.parse(iso)) / 1000));
  return seconds < 60 ? t("servers.detail.secondsAgo", { n: seconds }) : ago(iso, t, language);
}

/**
 * La salute in due pezzi: la parola («In trouble») e il quando («since
 * 09:40»), che la riga mette accanto e il riquadro Now usa nel titolo.
 */
export function healthParts(
  health: ServerRow["health"],
  t: TFunction,
  language: string,
): { word: string; when: string | null } {
  const word = t(`servers.health.${health.health}`);
  const since = health.since;
  switch (health.health) {
    case "healthy":
      return { word, when: null };
    case "never_connected":
      return { word, when: t("servers.when.waiting") };
    case "recovered":
      return { word, when: since ? ago(since, t, language) : null };
    case "down": {
      if (!since) return { word, when: null };
      const silent = health.reasons.every((r) => r.kind === "agent_silent");
      const key = silent ? "servers.when.noDataSince" : "servers.when.since";
      return { word, when: t(`${key}${dayKey(since)}`, { when: sinceWhen(since, language) }) };
    }
    case "trouble":
      return {
        word,
        when: since
          ? t(`servers.when.since${dayKey(since)}`, { when: sinceWhen(since, language) })
          : null,
      };
  }
}

/** «In trouble · since 09:40»: la salute in una frase (nomi accessibili). */
export function healthSentence(health: ServerRow["health"], t: TFunction, language: string) {
  const { word, when } = healthParts(health, t, language);
  return when ? `${word} · ${when}` : word;
}

/**
 * Un motivo in frase: «Memory at 94%, above 90% for 12 min», «Check “API
 * health” is down: connection refused», «The agent hasn't reported since
 * 14:02». `openSince` (un episodio aperto) aggiunge da quanto dura.
 */
export function reasonSentence(
  reason: EpisodeReason,
  checks: ServerCheck[],
  t: TFunction,
  language: string,
  openSince: string | null,
): string {
  switch (reason.kind) {
    case "cpu":
    case "memory":
    case "disk": {
      const base = t(`servers.reasons.${reason.kind}`, {
        value: Math.round(reason.valuePct),
        threshold: reason.thresholdPct,
      });
      if (!openSince) return base;
      return t("servers.reasons.forDuration", {
        reason: base,
        duration: duration(Date.parse(now()) - Date.parse(openSince), t),
      });
    }
    case "check": {
      const check = checks.find((c) => c.id === reason.checkId);
      if (!check) return t("servers.reasons.checkGone");
      return check.lastError
        ? t("servers.reasons.checkError", { name: check.name, error: check.lastError })
        : t("servers.reasons.check", { name: check.name });
    }
    case "agent_silent":
      return t(openSince ? "servers.reasons.silentOpen" : "servers.reasons.silentClosed", {
        time: clockLocal(reason.since, language),
      });
  }
}

/** «Production · ACQ (primary)» per ogni ambiente, separati da «·». */
export function environmentsLine(
  row: Pick<ServerRow, "environments" | "primaryProjectCode">,
  t: TFunction,
): string {
  return row.environments
    .map((e) => {
      const base = t("servers.envLine", {
        kind: t(`releases.environments.kinds.${e.kind}`),
        code: e.projectCode,
      });
      return e.kind === "production" && e.projectCode === row.primaryProjectCode
        ? t("servers.envPrimary", { env: base })
        : base;
    })
    .join(" · ");
}

/** Lo stato dell'accesso SSH da dire in una riga, solo se NON è a posto; `null` se lo è. */
export function accessProblem(row: Pick<ServerRow, "access">, t: TFunction): string | null {
  if (row.access === "verified" || row.access === "regenerating") return null;
  return t(`servers.access.${row.access}`);
}

/**
 * La seconda riga dopo gli ambienti: dove vanno le diagnosi quando non
 * restano in questo progetto, o che uno staging non avvisa.
 */
export function diagnosesLine(
  row: Pick<ServerRow, "analysisProject">,
  projectCode: string,
  t: TFunction,
): string | null {
  if (row.analysisProject === null) return t("servers.stagingOnly");
  if (row.analysisProject.code === projectCode) return null;
  return row.analysisProject.code
    ? t("servers.diagnosesGoTo", { code: row.analysisProject.code })
    : t("servers.diagnosesGoElsewhere");
}

/** Byte in parole corte: «412 GB», «38 MB». */
export function bytes(n: number, language: string): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = v >= 100 || i === 0 ? 0 : 1;
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: digits }).format(v)} ${units[i]}`;
}

/** Un numero con le cifre della lingua: «20,160». */
export const count = (n: number, language: string): string =>
  new Intl.NumberFormat(language).format(n);
