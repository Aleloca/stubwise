import { Link, Navigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { usePeople, useProject, useProjectDocsHome, useDocTree } from "../../data/queries";
import type { Project, ProjectDocsHome } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { formatDate } from "../../notifications/time";
import { PageError } from "../../tasks-ui/PageStates";
import { ProjectNotFound } from "../ProjectNotFound";
import {
  DocsForbidden,
  DocsGroup,
  GenerationLine,
  MinorMark,
  PageRefRow,
  ReadingSkeleton,
  isForbidden,
  productPages,
  releaseFirstLine,
  rowLinkClass,
  spaceLink,
} from "./parts";

/**
 * Il progetto di una vista dei Docs: caricamento, errore, progetto che non
 * c'è (o invisibile: identici), modulo spento (la sezione non esiste: si
 * torna all'Overview, come per le altre sezioni dei moduli).
 */
export function DocsProjectGate({
  code,
  children,
}: {
  code: string;
  children: (project: Project) => ReactNode;
}) {
  const { t } = useTranslation();
  const { data: project, isPending, isError, refetch } = useProject(code);
  if (isError) {
    return (
      <div className="page-header pl-4 [--page-header-pt:16px]">
        <PageError message={t("project.error")} onRetry={() => void refetch()} />
      </div>
    );
  }
  if (isPending) {
    return (
      <p role="status" className="p-8 text-sm text-ink-muted">
        {t("project.loading")}
      </p>
    );
  }
  if (!project) return <ProjectNotFound />;
  if (!project.modules.includes("docs")) {
    return <Navigate to="/p/$code/$section" params={{ code, section: "overview" }} replace />;
  }
  return <>{children(project)}</>;
}

/**
 * La pagina iniziale dei Docs di un progetto (shape docs.md §3): una colonna
 * di lettura con l'identità del brief, «Start here», gli spazi dei
 * repository col loro stato in parole, la sintesi del registro decisioni e
 * le novità. La chat del progetto (pannello a destra a 1440, «Ask the docs»
 * sotto a 1024) arriva col Task 3: qui ha solo il suo posto.
 */
export function DocsHome({ project }: { project: Project }) {
  const { t } = useTranslation();
  const home = useProjectDocsHome(project.id);

  if (home.isError && isForbidden(home.error)) return <DocsForbidden />;

  return (
    <section className="flex min-h-full pb-16 pl-8">
      <div className="flex w-full max-w-[752px] flex-col pr-8">
        <header className="page-header flex flex-col gap-1.5 [--page-header-pr:32px] [--page-header-pt:32px]">
          <h1 className="text-2xl font-semibold text-ink">{t("docs.title")}</h1>
          {/* L'identità del brief nomina già il progetto: niente nome ripetuto davanti. */}
          {home.data?.identity && (
            <p className="max-w-[72ch] text-sm text-ink-muted">{home.data.identity}</p>
          )}
        </header>
        {home.isError ? (
          <PageError message={t("docs.loadError")} onRetry={() => void home.refetch()} />
        ) : home.isPending ? (
          <ReadingSkeleton />
        ) : home.data ? (
          <HomeBody project={project} home={home.data} />
        ) : null}
      </div>
      {/* Task 3: la chat del progetto, pannello agganciato 360 px (A 2). */}
    </section>
  );
}

function HomeBody({ project, home }: { project: Project; home: ProjectDocsHome }) {
  const { t, i18n } = useTranslation();
  const { viewer } = useViewer();
  const people = usePeople().data;

  if (home.spaces.length === 0) {
    const canAdd = can(viewer, "repos.manage", project.id);
    return (
      <div className="flex flex-col items-start gap-2 pt-8">
        <h2 className="text-lg font-semibold text-ink">{t("docs.home.empty")}</h2>
        <p className="max-w-[60ch] text-md text-ink-muted">
          {canAdd ? t("docs.home.emptyBody") : t("docs.home.emptyAsk")}
        </p>
        {canAdd && (
          <Link
            to="/p/$code/$section"
            params={{ code: project.code, section: "settings" }}
            className="mt-2 inline-flex h-8 items-center rounded-md border border-rule-strong px-3 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
          >
            {t("docs.home.addRepository")}
          </Link>
        )}
      </div>
    );
  }

  const nameOf = (id: string | null) =>
    (id && people?.find((p) => p.id === id)?.name) || t("docs.home.someone");

  return (
    <>
      {home.startHere && <StartHere project={project} home={home} />}

      <DocsGroup title={t("docs.groups.spaces")} count={home.spaces.length}>
        <ul aria-label={t("docs.groups.spaces")} className="border-t border-rule">
          {home.spaces.map((space) => (
            <li key={space.repositoryId}>
              <Link {...spaceLink(project.code, space.name)} className={rowLinkClass}>
                <span
                  className="min-w-0 shrink truncate text-md font-semibold text-ink"
                  title={space.name}
                >
                  {space.name}
                </span>
                <span className="num shrink-0 text-sm text-ink-faint">
                  {t("docs.space.pages", { count: space.pageCount })}
                </span>
                <GenerationLine
                  space={space}
                  className="ml-auto max-w-[60%] text-sm text-ink-muted"
                />
              </Link>
            </li>
          ))}
        </ul>
      </DocsGroup>

      <DocsGroup
        title={t("docs.groups.decisions")}
        count={home.decisions.total}
        action={
          <Link
            to="/p/$code/$section"
            params={{ code: project.code, section: "overview" }}
            className="rounded-sm text-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline"
          >
            {t("docs.home.seeRegister")}
          </Link>
        }
      >
        {home.decisions.recent.length === 0 ? (
          <p className="border-t border-rule px-2 py-3 text-md text-ink-muted">
            {t("docs.home.noDecisions")}
          </p>
        ) : (
          <ul aria-label={t("docs.groups.decisions")} className="border-t border-rule">
            {home.decisions.recent.map((d) => (
              <li key={d.id} className="flex flex-col gap-0.5 border-b border-rule px-2 py-2.5">
                <span className="text-md text-ink">{d.title}</span>
                <span className="text-xs text-ink-muted">
                  {t("docs.home.decidedBy", { name: nameOf(d.decidedById) })} ·{" "}
                  <span className="num">{formatDate(d.decidedAt, i18n.language)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </DocsGroup>

      <DocsGroup title={t("docs.groups.whatsNew")}>
        {home.whatsNew.length === 0 ? (
          <p className="border-t border-rule px-2 py-3 text-md text-ink-muted">
            {t("docs.home.noReleases")}
          </p>
        ) : (
          <ul aria-label={t("docs.groups.whatsNew")} className="border-t border-rule">
            {home.whatsNew.map((r) => (
              <li
                key={r.id}
                className="grid grid-cols-[56px_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-b border-rule px-2 py-2.5"
              >
                <span className="num text-md font-semibold text-ink">{r.version}</span>
                <span className="flex min-w-0 items-center gap-2 text-xs text-ink-muted">
                  <span className="truncate">{r.repositoryName}</span>
                  <span aria-hidden="true">·</span>
                  <span className="num shrink-0">{formatDate(r.date, i18n.language)}</span>
                  {r.minor && <MinorMark />}
                </span>
                <span className="col-start-2 truncate text-md text-ink" title={releaseFirstLine(r)}>
                  {releaseFirstLine(r)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </DocsGroup>
    </>
  );
}

/**
 * «Start here»: le pagine di prodotto del repository principale (codice +
 * titolo); senza, il suo indice. Il brief del progetto entra qui col Task 3.
 */
function StartHere({ project, home }: { project: Project; home: ProjectDocsHome }) {
  const { t } = useTranslation();
  const main = home.startHere!;
  const tree = useDocTree(main.repositoryId);
  if (!tree.data) return null;
  const product = productPages(tree.data);
  return (
    <DocsGroup title={t("docs.groups.startHere")}>
      <ul aria-label={t("docs.groups.startHere")} className="border-t border-rule">
        {product.map((page) => (
          <PageRefRow key={page.id} page={page} projectCode={project.code} repo={main.name} />
        ))}
        {product.length === 0 && (
          <li>
            <Link {...spaceLink(project.code, main.name)} className={rowLinkClass}>
              <span className="min-w-0 truncate text-md text-ink">
                {t("docs.home.indexOf", { name: main.name })}
              </span>
            </Link>
          </li>
        )}
      </ul>
    </DocsGroup>
  );
}
