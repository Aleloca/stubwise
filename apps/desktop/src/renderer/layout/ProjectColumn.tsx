import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useProject } from "../data/queries";
import { PROJECT_SECTIONS } from "../data/routes";
import type { Project } from "../data/types";
import { can, useViewer } from "../data/viewer";

/** Una riga, ellissi in fondo. Inline perché il test la legge dallo stile calcolato. */
export const ONE_LINE: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export const columnItemClass =
  "flex h-8 min-w-0 items-center gap-2 rounded-md px-2.5 text-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink active:bg-ink/10 aria-[current=page]:bg-ink/10 aria-[current=page]:font-medium aria-[current=page]:text-ink";

function sectionsOf(project: Project) {
  return PROJECT_SECTIONS.filter((s) => !("module" in s) || project.modules.includes(s.module));
}

function Header({ code, project }: { code: string; project?: Project | null }) {
  const { t } = useTranslation();
  const kind = project
    ? project.kind === "client"
      ? [t("column.client"), project.clientName].filter(Boolean).join(" · ")
      : t("column.internal")
    : null;
  return (
    <header className="shrink-0 border-b border-rule px-4 pt-4 pb-3">
      <h2 className="flex min-w-0 items-baseline gap-2">
        <span className="num shrink-0 text-sm font-semibold tracking-[0.01em] text-ink">
          {project?.code ?? code.toUpperCase()}
        </span>
        {project && (
          <span title={project.name} style={ONE_LINE} className="min-w-0 text-lg font-semibold">
            {project.name}
          </span>
        )}
      </h2>
      {kind && (
        <p title={kind} style={ONE_LINE} className="mt-1 text-xs text-ink-muted">
          {kind}
        </p>
      )}
    </header>
  );
}

/**
 * Colonna di un progetto: testata (codice, nome, interno/cliente) e le
 * sezioni nell'ordine di `PROJECT_SECTIONS`, senza quelle dei moduli spenti.
 * «Settings» c'è sempre; senza `project.settings.manage` è in sola lettura.
 */
export function ProjectColumn({ code }: { code: string }) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const { data: project, isPending } = useProject(code);

  if (isPending || !project) return <Header code={code} project={isPending ? undefined : null} />;

  const canManage = can(viewer, "project.settings.manage", project.id);
  return (
    <>
      <Header code={code} project={project} />
      <nav
        aria-label={t("column.projectSections")}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
      >
        <ul className="flex flex-col gap-px">
          {sectionsOf(project).map((s) => (
            <li
              key={s.id}
              className={s.id === "settings" ? "mt-2 border-t border-rule pt-2" : undefined}
            >
              <Link
                to="/p/$code/$section"
                params={{ code: project.code, section: s.id }}
                data-section={s.id}
                style={{ whiteSpace: "nowrap" }}
                className={columnItemClass}
              >
                <span style={ONE_LINE} className="min-w-0">
                  {t(`project.sections.${s.id}`)}
                </span>
                {s.id === "settings" && !canManage && (
                  <span className="ml-auto shrink-0 text-xs font-normal text-ink-faint">
                    {t("column.viewOnly")}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
