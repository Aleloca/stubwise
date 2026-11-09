import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  usePeople,
  useProject,
  useProjectDocsHome,
  useDocTree,
  useProductSpace,
  useProjectSwitches,
  useSetDocsModule,
} from "../../data/queries";
import { SwitchOffLine } from "../../components/ProjectSwitchOff";
import { WhoCanLink } from "../../components/WhoCanLink";
import type { ProductPageRef, Project, ProjectDocsHome } from "../../data/types";
import { can, useViewer } from "../../data/viewing";
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
import { productIndexLink, productPageLink, useCreateAndOpen } from "../productDocs/parts";
import { primaryButton } from "../tasks/controls";
import {
  DocCode,
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
 * Dove si aggiunge un repository: Settings → Repositories, che c'è col modulo
 * Releases; senza, la prima sezione di Settings (Minor 1 del Task 10, area 9a).
 */
const repositoriesSection = (project: Project) =>
  project.modules.includes("releases") ? "repositories" : "statuses";

/**
 * Docs appena accesi sul posto (area 11a, [PS 6]): la pagina iniziale porta
 * il fuoco su «Start from a blank page», così non resta sul body quando il
 * bottone «Turn on Docs» se ne va. Per progetto e fuori dai componenti: da un
 * indirizzo di uno spazio di repository l'accensione porta alla pagina
 * iniziale, che è un'altra rotta.
 */
const turnedOn = new Set<string>();

/**
 * Il progetto di una vista dei Docs: caricamento, errore, progetto che non
 * c'è (o invisibile: identici), modulo spento: la colonna non mostra la
 * sezione, ma un indirizzo diretto dice che i Docs sono spenti e, a chi
 * gestisce il progetto, lo accende sul posto (shape §5, A 5; area 11a [PS 6]).
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
  if (!project.modules.includes("docs"))
    return <DocsTurnedOff project={project} />;
  return <>{children(project)}</>;
}

/**
 * I Docs spenti ([PS 6]): chi gestisce le impostazioni del progetto li
 * accende sul posto («Turn on Docs», spento mentre accende: un doppio clic
 * accende una volta); gli altri leggono chi può farlo, con «Who?».
 */
function DocsTurnedOff({ project }: { project: Project }) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const navigate = useNavigate();
  const location = useLocation();
  const canManage = can(viewer, "project.settings.manage", project.id);
  const turnOn = useSetDocsModule();
  const [failed, setFailed] = useState(false);
  // Un doppio clic accende una volta: il secondo arriva prima che il bottone si spenga.
  const inflight = useRef(false);
  const run = async () => {
    if (inflight.current) return;
    inflight.current = true;
    setFailed(false);
    // Prima della scrittura: la pagina iniziale può montarsi prima della risposta.
    turnedOn.add(project.id);
    const result = await turnOn.mutateAsync({ projectId: project.id, on: true }).catch(() => null);
    // Riuscita, la guardia resta: il bottone se ne va con la lettura nuova, e
    // un secondo clic arrivato prima non scrive di nuovo.
    if (result && result.ok) {
      // Da un indirizzo dentro i Docs (uno spazio, una pagina): la pagina iniziale.
      if (location.pathname !== `/p/${project.code}/docs`)
        void navigate({ to: "/p/$code/docs", params: { code: project.code } });
      return;
    }
    inflight.current = false;
    turnedOn.delete(project.id);
    setFailed(true);
  };
  return (
    <section className="page-header flex flex-col items-start gap-2 pb-8 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <h1 className="text-2xl font-semibold text-ink">
        {t("docs.off.title", { code: project.code })}
      </h1>
      {canManage ? (
        <>
          <p className="max-w-[60ch] text-md text-pretty text-ink-muted">
            {t("docs.off.bodyManageDocs")}
          </p>
          <button
            type="button"
            disabled={turnOn.isPending}
            onClick={() => void run()}
            className={`${primaryButton} mt-2 disabled:cursor-default disabled:opacity-60`}
          >
            {turnOn.isPending ? t("docs.off.turningOn") : t("docs.off.turnOnDocs")}
          </button>
          {failed && (
            <p role="alert" className="flex items-center gap-2 text-sm text-ink">
              {t("docs.off.turnOnFailed")}
              <button
                type="button"
                disabled={turnOn.isPending}
                onClick={() => void run()}
                className="rounded-md border border-rule-strong px-2 py-0.5 text-sm font-medium hover:bg-ink/6"
              >
                {t("docs.off.turnOnRetry")}
              </button>
            </p>
          )}
        </>
      ) : (
        <p className="max-w-[60ch] text-md text-pretty text-ink-muted">
          {t("docs.off.bodyOthers", { code: project.code })}{" "}
          <WhoCanLink
            action="manageProjectSettings"
            projectId={project.id}
            projectCode={project.code}
          />
        </p>
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
        {home.data && hasDocs(home.data) && !docked && (
          <AskTheDocs project={project} home={home.data} chat={chat} />
        )}
      </div>
      {home.data && hasDocs(home.data) && docked && (
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
 * C'è qualcosa da chiedere: uno spazio di repository, o lo spazio Prodotto
 * (che esiste anche senza repository, decisione 7 della spec). Una lettura
 * senza `product` (cambio additivo) resta com'era.
 */
const hasDocs = (home: ProjectDocsHome) => home.spaces.length > 0 || !!home.product;

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
  const nightlyOff = useNightlyOff(project.id);
  return (
    <section className="flex pb-12 pl-8">
      <div className="flex w-full max-w-[752px] flex-col pr-8">
        <header className="page-header flex flex-col gap-1.5 [--page-header-pr:32px] [--page-header-pt:32px]">
          <h1 className="text-2xl font-semibold text-ink">{t("docs.title")}</h1>
          {/* L'identità del brief nomina già il progetto: niente nome ripetuto davanti. */}
          {home.data?.identity && (
            <p className="max-w-[72ch] text-sm text-ink-muted">{home.data.identity}</p>
          )}
          {/* Area 9c: sotto la prosa della testata, sempre quando è spento. Senza
              repository (area 11a) non c'è niente che la notte aggiorni: niente riga. */}
          {nightlyOff && !(home.data && home.data.spaces.length === 0) && (
            <div className="max-w-[72ch] pt-1">
              <SwitchOffLine projectCode={project.code} kind="docsNightly">
                {t("projectEffects.docs.home", { code: project.code })}
              </SwitchOffLine>
            </div>
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

/**
 * I Docs notturni del progetto sono spenti (area 9c, Task 6): DocsHome e le
 * note di rilascio non promettono niente «every night». Finché gli
 * interruttori non sono letti, falso: mai «off» per sicurezza.
 */
export function useNightlyOff(projectId: string): boolean {
  const switches = useProjectSwitches(projectId);
  return switches.data ? !switches.data.docsNightly : false;
}

function HomeBody({ project, home }: { project: Project; home: ProjectDocsHome }) {
  const { t, i18n } = useTranslation();
  const nightlyOff = useNightlyOff(project.id);
  const { viewer } = useViewer();
  const people = usePeople().data;
  // Lo spazio Prodotto (area 11a): c'è quando la lettura lo porta; una
  // lettura senza `product` (cambio additivo) si disegna come prima ([PS 5]).
  const product = home.product ?? null;
  const productSpace = useProductSpace(project.id, {
    enabled: !!product && product.pageCount > 0,
  });
  const space = product && product.pageCount > 0 ? (productSpace.data ?? null) : null;

  if (home.spaces.length === 0 && !product) {
    const canAdd = can(viewer, "repos.manage", project.id);
    return (
      <div className="flex flex-col items-start gap-2 pt-8">
        <h2 className="text-lg font-semibold text-ink">{t("docs.home.empty")}</h2>
        <p className="max-w-[60ch] text-md text-ink-muted">
          {canAdd ? t("docs.home.emptyBody") : t("docs.home.emptyAsk")}
        </p>
        {canAdd && (
          <Link
            to="/p/$code/settings/$section"
            params={{ code: project.code, section: repositoriesSection(project) }}
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
      <StartHere project={project} home={home} first={space?.tree[0]?.page ?? null} />

      {product && (
        <ProductGroup
          project={project}
          product={product}
          latest={space?.recent[0] ?? null}
          nameOf={nameOf}
        />
      )}

      {/* Senza repository CODE non c'è, e nemmeno l'invito ad aggiungerne
          uno: quello vive nelle impostazioni del progetto ([PS 4]). */}
      {home.spaces.length > 0 && (
      <DocsGroup title={t("docs.groups.code")} count={home.spaces.length}>
        <ul aria-label={t("docs.groups.code")} className="border-t border-rule">
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
      )}

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

      {/* Senza repository non ci sono commit né note di rilascio: niente WHAT'S NEW ([PS 4]). */}
      {home.spaces.length > 0 && (
      <DocsGroup title={t("docs.groups.whatsNew")}>
        {home.whatsNew.length === 0 ? (
          <p className="border-t border-rule px-2 py-3 text-md text-ink-muted">
            {nightlyOff
              ? t("projectEffects.docs.noReleases", { code: project.code })
              : t("docs.home.noReleases")}
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
      )}
    </>
  );
}

/**
 * «Start here»: per prima la prima pagina radice dello spazio Prodotto
 * ([PS 3]: in un progetto senza repository è l'unica riga), poi il brief e
 * le pagine di prodotto del repository principale; senza, il suo indice.
 * Senza pagine e senza repository il gruppo non c'è.
 */
function StartHere({
  project,
  home,
  first,
}: {
  project: Project;
  home: ProjectDocsHome;
  first: ProductPageRef | null;
}) {
  if (home.startHere) return <StartHereWithRepo project={project} home={home} first={first} />;
  if (!first) return null;
  return <StartHereGroup project={project} first={first} />;
}

function StartHereGroup({
  project,
  first,
  children,
}: {
  project: Project;
  first: ProductPageRef | null;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <DocsGroup title={t("docs.groups.startHere")}>
      <ul aria-label={t("docs.groups.startHere")} className="border-t border-rule">
        {first && (
          <li>
            <Link {...productPageLink(project.code, first.code)} className={rowLinkClass}>
              <DocCode code={first.code} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-md text-ink" title={first.title}>
                  {first.title}
                </span>
                <span className="truncate text-xs text-ink-faint">{t("docs.home.productTag")}</span>
              </span>
            </Link>
          </li>
        )}
        {children}
      </ul>
    </DocsGroup>
  );
}

function StartHereWithRepo({
  project,
  home,
  first,
}: {
  project: Project;
  home: ProjectDocsHome;
  first: ProductPageRef | null;
}) {
  const { t } = useTranslation();
  const main = home.startHere!;
  const tree = useDocTree(main.repositoryId);
  if (!tree.data) return null;
  const product = productPages(tree.data);
  return (
    <StartHereGroup project={project} first={first}>
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
    </StartHereGroup>
  );
}

/**
 * Il gruppo PRODUCT ([PS 2]): una riga da 44 px come quella di uno spazio di
 * repository — «Product», le pagine, chi ha aggiornato per ultimo; vuoto,
 * «No pages yet» e, per chi scrive, «Start from a blank page». Dopo
 * l'accensione sul posto dei Docs il fuoco va su quell'azione.
 */
function ProductGroup({
  project,
  product,
  latest,
  nameOf,
}: {
  project: Project;
  product: NonNullable<ProjectDocsHome["product"]>;
  latest: ProductPageRef | null;
  nameOf: (id: string | null) => string;
}) {
  const { t, i18n } = useTranslation();
  const create = useCreateAndOpen(project);
  const start = useRef<HTMLButtonElement>(null);
  const row = useRef<HTMLAnchorElement>(null);
  const empty = product.pageCount === 0;
  const canStart = empty && product.canEdit;
  useEffect(() => {
    if (turnedOn.delete(project.id)) (start.current ?? row.current)?.focus();
  }, [project.id]);
  return (
    <DocsGroup title={t("docs.groups.product")} count={product.pageCount}>
      <ul aria-label={t("docs.groups.product")} className="border-t border-rule">
        <li className="flex min-w-0 items-center gap-3 border-b border-rule">
          <Link
            ref={row}
            {...productIndexLink(project.code)}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left outline-none transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
          >
            <span className="shrink-0 text-md font-semibold text-ink">
              {t("docs.home.productName")}
            </span>
            <span className="flex min-w-0 items-center gap-2 text-sm">
              {empty ? (
                <span className="text-ink-muted">{t("docs.home.productNoPages")}</span>
              ) : (
                <>
                  <span className="num shrink-0 text-ink-faint">
                    {t("docs.space.pages", { count: product.pageCount })}
                  </span>
                  {latest && (
                    <>
                      <span aria-hidden="true" className="text-ink-faint">
                        ·
                      </span>
                      <span className="num min-w-0 truncate text-ink-muted">
                        {t("docs.home.productUpdated", {
                          date: formatDate(latest.updatedAt, i18n.language),
                          name: nameOf(latest.updatedById),
                        })}
                      </span>
                    </>
                  )}
                </>
              )}
            </span>
          </Link>
          {canStart && (
            <button
              ref={start}
              type="button"
              disabled={create.isPending}
              onClick={() => void create.run(null)}
              className="mr-2 shrink-0 rounded-sm text-sm font-medium text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink disabled:opacity-60"
            >
              {t("docs.home.productStart")}
            </button>
          )}
        </li>
      </ul>
    </DocsGroup>
  );
}
