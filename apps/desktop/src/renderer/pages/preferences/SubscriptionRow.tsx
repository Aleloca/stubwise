import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ProjectSubscriptions, SubscriptionRow as Row } from "../../data/alerts";
import { useSaveSwitch } from "./useAlertActions";

// Una riga delle iscrizioni (shape alerts.md, «Riga di un tipo»): il nome e
// il «quando» a sinistra, a destra due interruttori in colonna (App,
// Telefono) — o, per una riga sospesa o solo obbligatoria, la frase che dice
// perché non si tocca. La UI non calcola stati: li legge dalla riga.

/** Larghezza di una colonna di interruttori: la pagina e il popover le allineano con l'intestazione. */
export const SWITCH_COL = "w-14";

/** Il «quando» di un tipo: la chiave segue quella del nome (`alerts.types.x` → `alerts.when.x`). */
export const whenKeyOf = (labelKey: string) => labelKey.replace(/^alerts\.types\./, "alerts.when.");

/** Le frasi sotto il nome: il «quando», poi l'obbligo («Always when you did the merge»), se c'è. */
export function rowLines(t: TFunction, row: Row, code: string): string[] {
  const lines: string[] = [];
  const whenKey = whenKeyOf(row.labelKey);
  if (t(whenKey, { code, defaultValue: "" })) lines.push(t(whenKey, { code }));
  // Una riga solo obbligatoria ha già «Always for you» a destra.
  if (row.state !== "mandatory" && row.mandatory.length > 0) {
    lines.push(row.mandatory.map((m) => t(`alerts.mandatoryLine.${m}`)).join(" · "));
  }
  return lines;
}

/** «Paused · you can no longer see AUD's repositories»: ciò che non si vede più, mai il permesso. */
export function suspendedText(t: TFunction, row: Row, code: string): string {
  const key = row.suspendedReason
    ? `alerts.suspended.${row.suspendedReason.replace(/\./g, "_")}`
    : "";
  return key && t(key, { code, defaultValue: "" })
    ? t(key, { code })
    : t("alerts.suspended.other", { code });
}

export interface AlertSummary {
  on: number;
  phone: number;
  paused: number;
  always: number;
}

export function countRows(rows: Row[]): AlertSummary {
  return {
    on: rows.filter((r) => r.state === "on").length,
    phone: rows.filter((r) => r.state === "on" && r.phone).length,
    paused: rows.filter((r) => r.state === "suspended").length,
    always: rows.filter((r) => r.state === "mandatory").length,
  };
}

/** La sintesi in parole: «7 on · 2 to phone», «3 on · 1 paused», «Everything off · 2 always on». */
export function summaryText(t: TFunction, rows: Row[]): string {
  if (rows.length === 0) return t("alerts.nothingHere");
  const c = countRows(rows);
  const parts = c.on > 0 ? [t("alerts.summary.on", { count: c.on })] : [t("alerts.summary.allOff")];
  if (c.on > 0 && c.phone > 0) parts.push(t("alerts.summary.phone", { count: c.phone }));
  if (c.on === 0 && c.always > 0) parts.push(t("alerts.summary.always", { count: c.always }));
  if (c.paused > 0) parts.push(t("alerts.summary.paused", { count: c.paused }));
  return parts.join(" · ");
}

/** Le righe per famiglia, nell'ordine in cui arrivano (quello del catalogo). */
export function byGroup(rows: Row[]): [string, Row[]][] {
  const out = new Map<string, Row[]>();
  for (const r of rows) out.set(r.group, [...(out.get(r.group) ?? []), r]);
  return [...out];
}

/**
 * Un interruttore: inchiostro pieno con il pallino del fondo se acceso,
 * contorno se spento (lo stato è la forma, non un colore). Disattivato resta
 * raggiungibile (`aria-disabled`) e dice perché nel suggerimento.
 */
export function Switch({
  checked,
  label,
  disabledReason,
  describedBy,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabledReason?: string;
  describedBy?: string;
  onChange: (next: boolean) => void;
}) {
  const disabled = disabledReason !== undefined;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      title={disabledReason}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      className={`relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors duration-[var(--duration-fast)] ease-out ${
        checked ? "border-ink bg-ink" : "border-rule-strong bg-transparent hover:border-ink/40"
      } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-1/2 size-3 -translate-y-1/2 rounded-full transition-[left,background-color] duration-[var(--duration-fast)] ease-out ${
          checked ? "left-[15px] bg-ground" : "left-[2px] bg-ink-muted"
        }`}
      />
    </button>
  );
}

/** I due interruttori di una riga accesa o spenta. Telefono richiede App (shape [A 7]). */
function Switches({
  row,
  code,
  describedBy,
  save,
}: {
  row: Row;
  code: string;
  describedBy: string;
  save: (row: Row, change: { app?: boolean; phone?: boolean }) => void;
}) {
  const { t } = useTranslation();
  const label = t(row.labelKey);
  return (
    <span className="flex shrink-0">
      <span className={`flex ${SWITCH_COL} justify-center`}>
        <Switch
          checked={row.app}
          label={t("alerts.switchName", { label, code, channel: t("alerts.app") })}
          describedBy={describedBy}
          onChange={(app) => save(row, { app })}
        />
      </span>
      <span className={`flex ${SWITCH_COL} justify-center`}>
        <Switch
          checked={row.app && row.phone}
          label={t("alerts.switchName", { label, code, channel: t("alerts.phone") })}
          describedBy={describedBy}
          disabledReason={row.app ? undefined : t("alerts.appFirst")}
          onChange={(phone) => save(row, { phone })}
        />
      </span>
    </span>
  );
}

/**
 * Una riga. `compact` (il popover del progetto): solo il nome, il «quando»
 * nel `title` e nel nome accessibile; sospesa e obbligatoria in una parola.
 */
export function SubscriptionRow({
  project,
  row,
  compact = false,
}: {
  project: Pick<ProjectSubscriptions, "projectId" | "code">;
  row: Row;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const save = useSaveSwitch(project);
  const whenId = useId();
  const code = project.code;
  const lines = rowLines(t, row, code);
  const label = t(row.labelKey);

  let right;
  if (row.state === "suspended") {
    const reason = suspendedText(t, row, code);
    right = compact ? (
      <span title={`${reason}. ${t("alerts.suspendedBack")}`} className="text-sm text-ink-muted">
        {t("alerts.pausedShort")}
        <span className="sr-only">
          {" "}
          · {reason}. {t("alerts.suspendedBack")}
        </span>
      </span>
    ) : (
      <span className="flex max-w-[280px] flex-col text-right text-sm text-ink-muted">
        <span>{reason}</span>
        <span className="text-ink-faint">{t("alerts.suspendedBack")}</span>
      </span>
    );
  } else if (row.state === "mandatory") {
    right = (
      <span className="flex flex-col text-right text-sm">
        <span className="text-ink">{t("alerts.always")}</span>
        {!compact && (
          <span className="text-ink-faint">
            {t(row.phone ? "alerts.alwaysPhone" : "alerts.alwaysApp")}
          </span>
        )}
      </span>
    );
  } else {
    right = <Switches row={row} code={code} describedBy={whenId} save={save} />;
  }

  return (
    <li
      data-alert-row={row.type}
      data-state={row.state}
      title={compact ? lines.join(" · ") || undefined : undefined}
      className={`flex items-start justify-between gap-4 ${compact ? "min-h-9 items-center py-1.5" : "py-2.5"}`}
    >
      <span className="flex min-w-0 flex-col">
        <span className={`text-ink ${compact ? "text-sm" : "text-md"}`}>{label}</span>
        {lines.length > 0 && (
          <span id={whenId} className={compact ? "sr-only" : "text-sm text-ink-muted"}>
            {lines.map((line, i) => (
              <span key={i} className="block">
                {line}
              </span>
            ))}
          </span>
        )}
      </span>
      <span className={compact ? "shrink-0" : "shrink-0 pt-0.5"}>{right}</span>
    </li>
  );
}

/** Le famiglie di un progetto, ognuna col suo titolo di gruppo. */
export function FamilyList({
  project,
  rows,
  compact = false,
}: {
  project: Pick<ProjectSubscriptions, "projectId" | "code">;
  rows: Row[];
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <>
      {byGroup(rows).map(([group, list]) => (
        <section key={group} aria-labelledby={`${headingId}-${group}`} className="mt-2 first:mt-0">
          <h4
            id={`${headingId}-${group}`}
            className={`heading-group ${compact ? "pt-2 pb-0.5" : "pt-3 pb-1"}`}
          >
            {t(`alerts.groups.${group}`, { defaultValue: group })}
          </h4>
          <ul className="flex flex-col divide-y divide-rule">
            {list.map((row) => (
              <SubscriptionRow key={row.type} project={project} row={row} compact={compact} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
