import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { usePeople, useProject, useProjectDocsHome, useDocTree } from "../../data/queries";
import type { Project, ProjectDocsHome } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import {
  ChatStart,
  DocsChatPanel,
  DocsComposer,
  Unavailable,
  useDocsChat,
  type DocsChatState,
} from "./DocsChat";
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
 * c'è (o invisibile: identici), modulo spento: la colonna non mostra la
 * sezione, ma un indirizzo diretto dice che i Docs sono spenti e, a chi
 * gestisce il progetto, dove accenderli (shape §5, A 5).
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
  if (!project.modules.includes("docs")) return <DocsTurnedOff project={project} />;
  return <>{children(project)}</>;
}

function DocsTurnedOff({ project }: { project: Project }) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const canManage = can(viewer, "project.settings.manage", project.id);
  return (
    <section className="page-header flex flex-col items-start gap-2 pb-8 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <h1 className="text-2xl font-semibold text-ink">
        {t("docs.off.title", { code: project.code })}
      </h1>
      <p className="max-w-[60ch] text-md text-ink-muted">
        {canManage ? t("docs.off.bodyManage") : t("docs.off.body")}
      </p>
      {canManage && (
        <Link
          to="/p/$code/$section"
          params={{ code: project.code, section: "settings" }}
          className="mt-2 inline-flex h-8 items-center rounded-md border border-rule-strong px-3 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
        >
          {t("docs.off.turnOn")}
        </Link>
      )}
    </section>
  );
}

/**
 * La pagina iniziale dei Docs di un progetto (shape docs.md §3): una colonna
 * di lettura con l'identità del brief, «Start here», gli spazi dei
 * repository col loro stato in parole, la sintesi del registro decisioni e
 * le novità. La chat del progetto è un pannello agganciato a destra (360
 * px) da 1200 px; sotto, la sezione «Ask the docs» in fondo (A 2).
 */
export function DocsHome({ project }: { project: Project }) {
  const { t } = useTranslation();
  const home = useProjectDocsHome(project.id);
  const docked = useMediaQuery(DOCKED_PANEL_QUERY);
  const chat = useDocsChat({ projectId: project.id });

  if (home.isError && isForbidden(home.error)) return <DocsForbidden />;

  return (
    <div className="relative flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <HomeColumn project={project} home={home} />
        {home.data && home.data.spaces.length > 0 && !docked && (
          <AskTheDocs project={project} home={home.data} chat={chat} />
        )}
      </div>
      {home.data && home.data.spaces.length > 0 && docked && (
        <DocsChatPanel
          chat={chat}
          available={home.data.chatAvailable}
          suggestions={home.data.chatSuggestions}
          scope={project.code}
          placeholder={t("docs.chat.placeholderProject", { code: project.code })}
          className="w-[360px] shrink-0 border-l border-rule"
        />
      )}
    </div>
  );
}

/**
 * Sotto i 1200 px la chat del progetto scende sotto il contenuto come
 * sezione «Ask the docs» (la casella e le domande); la conversazione si apre
 * sovrapposta a destra, 400 px, col fuoco dentro (A 2).
 */
function AskTheDocs({
  project,
  home,
  chat,
}: {
  project: Project;
  home: ProjectDocsHome;
  chat: DocsChatState;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement>(null);
  const send = (question: string) => {
    chat.send(question);
    setOpen(true);
  };
  const close = useCallback(() => {
    setOpen(false);
    opener.current?.querySelector<HTMLElement>("textarea")?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);
  const sending = { ...chat, send };
  return (
    <section
      ref={opener}
      aria-label={t("docs.chat.title")}
      className="max-w-[752px] pr-8 pb-16 pl-8"
    >
      <DocsGroup
        title={t("docs.chat.title")}
        action={
          chat.turns.length > 0 && !open ? (
            <button
              type="button"
              className="rounded-sm text-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline"
              onClick={() => setOpen(true)}
            >
              {t("docs.chat.open")}
            </button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-3 border-t border-rule pt-3">
          <ChatStart
            chat={sending}
            available={home.chatAvailable && !chat.unavailable}
            suggestions={home.chatSuggestions}
            scope={project.code}
          />
          {home.chatAvailable && !chat.unavailable ? (
            <DocsComposer
              placeholder={t("docs.chat.placeholderProject", { code: project.code })}
              disabled={chat.busy}
              onSend={send}
            />
          ) : (
            <Unavailable />
          )}
        </div>
      </DocsGroup>
      {open && (
        <div className="absolute top-0 right-0 bottom-0 z-30 flex w-[400px] max-w-full border-l border-rule-strong bg-surface shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]">
          <DocsChatPanel
            chat={chat}
            available={home.chatAvailable}
            suggestions={home.chatSuggestions}
            scope={project.code}
            placeholder={t("docs.chat.placeholderProject", { code: project.code })}
            onClose={close}
            autoFocus
            className="h-full w-full"
          />
        </div>
      )}
    </section>
  );
}

function HomeColumn({
  project,
  home,
}: {
  project: Project;
  home: ReturnType<typeof useProjectDocsHome>;
}) {
  const { t } = useTranslation();
  return (
    <section className="flex pb-12 pl-8">
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
                {/* Lo stato sta accanto al nome, dopo il conteggio: chi legge
                    la riga lo trova dove guarda, non all'altro capo. */}
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="num shrink-0 text-ink-faint">
                    {t("docs.space.pages", { count: space.pageCount })}
                  </span>
                  <span aria-hidden="true" className="text-ink-faint">
                    ·
                  </span>
                  <GenerationLine space={space} className="text-ink-muted" />
                </span>
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
        {main.hasBrief && (
          <li>
            <Link
              to="/p/$code/docs/$repo/brief"
              params={{ code: project.code, repo: main.name }}
              className={rowLinkClass}
            >
              {/* Il brief non è una pagina: niente codice, la colonna resta allineata. */}
              <span aria-hidden="true" className="w-[60px] shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-md text-ink">{t("docs.brief.projectBrief")}</span>
                <span className="truncate text-xs text-ink-faint">{main.name}</span>
              </span>
            </Link>
          </li>
        )}
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
