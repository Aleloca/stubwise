import { Link } from "@tanstack/react-router";
import { useId, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { ChangeDiff, ChangeEntryView } from "../../data/queries";
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
    ) : (
      <Link
        to="/p/$code/settings/$section"
        params={{ code: l.projectCode, section: "members" }}
        search={{ member: l.personId }}
        className={linkClass}
      >
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

/** La seconda riga, in parole: «Developer → Release manager», «+ a, + b · − c». */
function useDiffLine() {
  const { t } = useTranslation();
  const words = usePermissionWords();
  return (diff: ChangeDiff): string | null => {
    const none = t("changelog.entry.none");
    switch (diff.kind) {
      case "values":
        return `${diff.before ?? none} → ${diff.after ?? none}`;
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
          diff.hidden > 0 ? t("changelog.entry.others", { count: diff.hidden }) : "",
        ];
        return parts.filter(Boolean).join(" · ") || null;
      }
    }
  };
}

/** Un numero nei valori della voce (task riassegnate, spostate), se c'è ed è più di zero. */
const countParam = (entry: ChangeEntryView, key: string): number => {
  const n = Number(entry.params[key] ?? "0");
  return Number.isFinite(n) ? n : 0;
};

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
  const values = {
    actor: entry.actorName,
    object: entry.object.label,
    project: entry.projectCode ?? entry.params.project ?? "",
    role: entry.params.role ?? entry.after ?? "",
    permission: words(permission),
  };
  const line = entry.diff ? diffLine(entry.diff) : null;
  const reassigned =
    entry.kind === "person.deactivated" ? countParam(entry, "reassigned") : 0;
  const moved = entry.kind === "department.deleted" ? countParam(entry, "moved") : 0;
  const extra = [
    reassigned > 0 ? t("changelog.entry.reassigned", { count: reassigned }) : null,
    moved > 0 ? t("changelog.entry.moved", { count: moved }) : null,
  ].filter(Boolean);
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
      <time
        dateTime={entry.at}
        className="num pt-px text-xs leading-5 text-ink-faint"
      >
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
        {(line || extra.length > 0) && (
          <p className="mt-0.5 text-sm text-pretty text-ink-muted">
            {[line, ...extra].filter(Boolean).join(" · ")}
          </p>
        )}
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
