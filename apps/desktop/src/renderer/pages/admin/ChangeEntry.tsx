import { Link } from "@tanstack/react-router";
import { useId, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import type {
  AutomationRuleValue,
  ChangeDiff,
  ChangeEntryView,
  FieldValue,
  SettingValue,
} from "../../data/queries";
import { capitalized, usePermissionWords } from "./parts";

// Una voce del registro delle modifiche (shape admin-audit.md, `ChangeEntry`).
// È un FATTO: la frase viene dal template i18n del tipo (`templateKey`), con
// chi ha agito in 600 e l'oggetto come link quando esiste ed è visibile; a
// destra il codice del progetto. Sotto, il prima/dopo riassunto su una riga
// e, per gli elenchi di permessi, «Show details» con le due colonne [AU 2].
// Nessuna azione: una voce non si modifica né si cancella. 9b e 9c aggiungono
// tipi e template senza toccare questo componente.

/** L'ora della voce in cifre tabellari («10:12»), UTC come l'orologio del prototipo. */
function timeOf(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(iso));
}

/** Giorno e ora («Oct 22, 18:00», «22 ott, 18:00»), UTC come l'orologio del prototipo. */
function dayTimeOf(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(iso));
}

const linkClass =
  "font-semibold text-ink underline-offset-2 decoration-rule-strong hover:underline focus-visible:underline";

/** L'oggetto della frase: un link se esiste ed è visibile, il nome con «(deleted)» se non c'è più. */
function ObjectRef({ entry, children }: { entry: ChangeEntryView; children?: ReactNode }) {
  const { t } = useTranslation();
  const l = entry.objectLink;
  const name = l ? (
    l.to === "person" ? (
      <Link to="/admin/people/$personId" params={{ personId: l.personId }} className={linkClass}>
        {children}
      </Link>
    ) : l.to === "role" ? (
      <Link to="/admin/roles/$roleId" params={{ roleId: l.roleId }} className={linkClass}>
        {children}
      </Link>
    ) : l.to === "invite" ? (
      <Link
        to="/admin/people/invites/$inviteId"
        params={{ inviteId: l.inviteId }}
        className={linkClass}
      >
        {children}
      </Link>
    ) : l.to === "department" ? (
      <Link
        to="/admin/$section"
        params={{ section: "departments" }}
        search={{ department: l.departmentId }}
        className={linkClass}
      >
        {children}
      </Link>
    ) : l.to === "member" ? (
      <Link
        to="/p/$code/settings/$section"
        params={{ code: l.projectCode, section: "members" }}
        search={{ member: l.personId }}
        className={linkClass}
      >
        {children}
      </Link>
    ) : l.to === "admin" && l.section === "plugins" && l.id ? (
      // Un plugin ha la sua pagina (9b, Task 10).
      <Link to="/admin/plugins/$pluginId" params={{ pluginId: l.id }} className={linkClass}>
        {children}
      </Link>
    ) : l.to === "admin" ? (
      // La voce d'istanza (9b) in cui sta l'oggetto; le voci con una pagina
      // per oggetto la aprono dall'elenco.
      <Link to="/admin/$section" params={{ section: l.section }} className={linkClass}>
        {children}
      </Link>
    ) : (
      // Un server d'istanza: il suo dettaglio dentro Servers dell'Amministrazione (9b).
      <Link to="/admin/servers/$server" params={{ server: l.code }} className={linkClass}>
        {children}
      </Link>
    )
  ) : (
    <span className="font-semibold text-ink">{children}</span>
  );
  return (
    <>
      {name}
      {entry.objectDeleted && (
        <span className="text-ink-muted"> {t("changelog.entry.deleted")}</span>
      )}
    </>
  );
}

/** «$600», «$12.50». */
const usd = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
/** «opus» → «Opus»; un id preciso («claude-opus-5-5») resta com'è. */
const modelName = (m: string): string =>
  /^[a-z]+$/.test(m) ? `${m[0]!.toUpperCase()}${m.slice(1)}` : m;

/**
 * Un valore stabile di una voce d'impostazione del 9b (Ruling T3), nella
 * lingua di chi legge: la voce salva `on`, `default:sonnet`, `600`, `it`…,
 * le parole sono qui.
 */
function useSettingWords() {
  const { t, i18n } = useTranslation();
  const rule = (r: AutomationRuleValue): string => {
    const parts = [
      t(r.autoFix ? "changelog.values.autoFix" : "changelog.values.autoFixOff", {
        effort: r.maxEffort,
      }),
    ];
    if (r.planApprovalMinEffort !== null)
      parts.push(t("changelog.values.planApproval", { effort: r.planApprovalMinEffort }));
    if (r.maxCostUsd !== null) parts.push(t("changelog.values.cap", { amount: usd(r.maxCostUsd) }));
    return `${t(`taskDetail.types.${r.taskType}`)}: ${parts.join(", ")}`;
  };
  return (v: SettingValue | null): string => {
    if (v === null) return t("changelog.entry.none");
    switch (v.type) {
      case "switch":
        return t(v.on ? "changelog.values.on" : "changelog.values.off");
      case "model":
        return v.source === "set"
          ? modelName(v.model)
          : t(`changelog.values.model.${v.source}`, { model: modelName(v.model) });
      case "budget":
        return v.usd === null ? t("changelog.values.noBudget") : usd(v.usd);
      case "language":
        return t(`rail.languages.${v.locale}`);
      case "automation": {
        const parts = v.rules.map(rule);
        if (v.prReview)
          parts.push(
            !v.prReview.enabled
              ? t("changelog.values.reviewOff")
              : v.prReview.maxCostUsd === null
                ? t("changelog.values.reviewNoCap")
                : t("changelog.values.reviewCap", { amount: usd(v.prReview.maxCostUsd) }),
          );
        return parts.join(" · ");
      }
      case "fields":
        // Detto campo per campo da `useFieldsLine`, mai come valore unico.
        return "";
      case "queue":
        return v.pausedSince === null
          ? t("changelog.values.queueRunning")
          : t("changelog.values.queuePaused", { date: dayTimeOf(v.pausedSince, i18n.language) });
    }
  };
}

/**
 * La riga di una voce `fields` del 9b (Task 4): campo per campo, «Workspace
 * audin → audin-srl», e per le liste ciò che entra ed esce («Events +
 * Release failed, − Pull request opened by Claude»), separati da « · ». Il
 * nome del campo e le parole di Stubwise (on/off, il formato e gli eventi
 * del webhook) sono qui; i valori dati da una persona restano com'erano.
 */
function useFieldsLine() {
  const { t } = useTranslation();
  const word = (field: string, v: string | boolean | null | undefined): string => {
    if (v === null || v === undefined || v === "") return t("changelog.entry.none");
    if (typeof v === "boolean") return t(v ? "changelog.values.on" : "changelog.values.off");
    // Il segnaposto di `changelog/reads.ts` (`HIDDEN_PROJECT`): una pagina non importa il livello dati.
    if (field === "primaryProject" && v === "@hidden") return t("changelog.values.hiddenProject");
    if (field === "format") return t(`changelog.values.webhookFormat.${v}`);
    // L'id ha dei punti (`job.pr_opened`), che i18next leggerebbe come livelli.
    if (field === "events") return t(`changelog.values.webhookEvents.${v.replace(/\./g, "_")}`);
    return v;
  };
  return (
    before: Record<string, FieldValue> | null,
    after: Record<string, FieldValue> | null,
  ): string | null => {
    const keys = [...new Set([...Object.keys(after ?? {}), ...Object.keys(before ?? {})])];
    const parts = keys.map((key) => {
      const label = t(`changelog.fields.${key}`);
      const b = before?.[key];
      const a = after?.[key];
      if (Array.isArray(a) || Array.isArray(b)) {
        const from = Array.isArray(b) ? b : [];
        const to = Array.isArray(a) ? a : [];
        const items = [
          ...to.filter((x) => !from.includes(x)).map((x) => `+ ${word(key, x)}`),
          ...from.filter((x) => !to.includes(x)).map((x) => `− ${word(key, x)}`),
        ];
        return `${label} ${items.join(", ")}`;
      }
      return `${label} ${word(key, b)} → ${word(key, a)}`;
    });
    return parts.join(" · ") || null;
  };
}

/** La seconda riga, in parole: «Developer → Release manager», «+ a, + b · − c». */
function useDiffLine() {
  const { t } = useTranslation();
  const words = usePermissionWords();
  const setting = useSettingWords();
  const fieldsLine = useFieldsLine();
  return (diff: ChangeDiff): string | null => {
    const none = t("changelog.entry.none");
    switch (diff.kind) {
      case "values":
        return `${diff.before ?? none} → ${diff.after ?? none}`;
      case "setting":
        if (diff.before?.type === "fields" || diff.after?.type === "fields")
          return fieldsLine(
            diff.before?.type === "fields" ? diff.before.fields : null,
            diff.after?.type === "fields" ? diff.after.fields : null,
          );
        return `${setting(diff.before)} → ${setting(diff.after)}`;
      case "permissions": {
        if (diff.role) {
          const extra = [...diff.added, ...diff.removed].map(words).join(", ");
          return diff.added.length > 0
            ? `${diff.role} → ${diff.role} + ${extra}`
            : `${diff.role} + ${extra} → ${diff.role}`;
        }
        const plus = diff.added.map((p) => `+ ${words(p)}`).join(", ");
        const minus = diff.removed.map((p) => `− ${words(p)}`).join(", ");
        return [plus, minus].filter(Boolean).join(" · ") || null;
      }
      case "people": {
        const parts = [
          diff.added.map((n) => `+ ${n}`).join(", "),
          diff.removed.map((n) => `− ${n}`).join(", "),
        ];
        return parts.filter(Boolean).join(" · ") || null;
      }
    }
  };
}

export function ChangeEntry({
  entry,
  showProject = true,
}: {
  entry: ChangeEntryView;
  /** Il codice del progetto a destra (nel registro di un progetto è sempre lo stesso: no). */
  showProject?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const words = usePermissionWords();
  const diffLine = useDiffLine();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const permission = entry.params.permission ?? entry.after ?? entry.before ?? "";
  // I parametri della voce (quelli del 9b: `kind`, `provider`, `ref`,
  // `check`, `scope`, vedi `instance/changeTypes.ts`) prima delle chiavi
  // calcolate, che vincono sempre.
  const values = {
    ...entry.params,
    actor: entry.actorName,
    // Il nome di un oggetto che è una parola di Stubwise (l'operazione di
    // `model.changed`) si traduce; un nome dato da una persona resta com'è.
    object: entry.objectLabelKey ? t(entry.objectLabelKey) : entry.object.label,
    project: entry.projectCode ?? entry.params.project ?? "",
    role: entry.params.role ?? entry.after ?? "",
    permission: words(permission),
  };
  const line = entry.diff ? diffLine(entry.diff) : null;
  const details =
    entry.diff?.kind === "permissions" && entry.diff.before && entry.diff.after
      ? { before: entry.diff.before, after: entry.diff.after }
      : null;
  const code = showProject && entry.projectCode ? entry.projectCode : null;

  return (
    <article
      data-change-entry={entry.kind}
      className="@container grid grid-cols-[48px_minmax(0,1fr)] gap-x-3 py-3"
    >
      <time dateTime={entry.at} className="num pt-px text-xs leading-5 text-ink-faint">
        {timeOf(entry.at, i18n.language)}
      </time>
      <div className="min-w-0">
        <div className="flex flex-col gap-0.5 @[760px]:flex-row @[760px]:items-baseline @[760px]:gap-4">
          <p className="min-w-0 flex-1 text-md text-pretty text-ink">
            <Trans
              i18nKey={entry.templateKey}
              values={values}
              components={{
                actor: <span className="font-semibold" />,
                object: <ObjectRef entry={entry} />,
                strong: <strong className="font-semibold" />,
              }}
            />
          </p>
          {code && (
            <span
              title={t("changelog.entry.projectLabel", { code })}
              className="num shrink-0 text-xs font-semibold text-ink-muted @[760px]:text-sm"
            >
              {code}
            </span>
          )}
        </div>
        {line && <p className="mt-0.5 text-sm text-pretty text-ink-muted">{line}</p>}
        {details && (
          <>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => setOpen((o) => !o)}
              className="mt-1 rounded-sm text-sm font-medium text-ink-muted underline-offset-2 hover:text-ink hover:underline"
            >
              {open ? t("changelog.entry.hideDetails") : t("changelog.entry.showDetails")}
            </button>
            <div
              id={detailsId}
              hidden={!open}
              className="details-expand mt-2 grid grid-cols-1 gap-3 border-l border-rule pl-3 @[760px]:grid-cols-2"
            >
              {(["before", "after"] as const).map((side) => (
                <div key={side} className="min-w-0">
                  <h3 className="heading-group pb-1">{t(`changelog.entry.${side}`)}</h3>
                  {details[side].length === 0 ? (
                    <p className="text-sm text-ink-muted">{t("changelog.entry.nothing")}</p>
                  ) : (
                    <ul className="flex flex-col gap-0.5 text-sm text-ink">
                      {details[side].map((p) => {
                        const changed =
                          side === "before"
                            ? !details.after.includes(p)
                            : !details.before.includes(p);
                        return (
                          <li
                            key={p}
                            title={p}
                            className={changed ? "font-semibold" : "text-ink-muted"}
                          >
                            {changed && (side === "before" ? "− " : "+ ")}
                            {capitalized(words(p), i18n.language)}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </article>
  );
}
