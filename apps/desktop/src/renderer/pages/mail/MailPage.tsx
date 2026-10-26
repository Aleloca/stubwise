import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  useGoogleAccount,
  useMailboxes,
  useMailDrafts,
  useMailSearch,
  useMailThread,
  useMailThreads,
  useProjects,
} from "../../data/queries";
import { onBeforePersonaChange } from "../../data/session";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { hasModKey } from "../../platform/platform";
import { primaryButton } from "../claude/conversation/parts";
import { openGoogleAccount } from "../drive/GoogleAccountCard";
import { filtersOf, mailProjectsOf, withoutProject, type MailSearch } from "./mailFilters";
import { ReadingPane } from "./ReadingPane";
import { ThreadList } from "./ThreadList";
import type { ProjectRef } from "./ThreadRow";

// La destinazione «Mail» (shape mail.md): elenco per conversazione e
// pannello di lettura, coi filtri e la conversazione aperta nell'indirizzo
// (`#/mail/<threadId>?mailbox=&importance=&project=&q=`). Sotto un'area di
// lavoro di ~1100 px i due diventano uno per volta (A4). Cambiare persona
// rimonta la pagina (router): qui si chiudono ricerca e casella della
// persona di prima, e la conversazione se la nuova non la vede.

/**
 * Elenco e pannello affiancati: un'area di lavoro di almeno ~1100 px (la
 * finestra meno binario e colonna, 304 px). A 1440 sono affiancati, a 1024
 * uno per volta.
 */
export const MAIL_TWO_UP_QUERY = "(min-width: 1400px)";

export function MailPage({
  switchedPersona,
}: {
  /**
   * Il cambio di persona è appena avvenuto (la tiene la route, che la
   * pagina rimontata non perde): se la conversazione aperta non è visibile
   * alla persona nuova, l'indirizzo torna a `#/mail` — non resta un «non
   * esiste» che parla della posta di un altro.
   */
  switchedPersona: MutableRefObject<boolean>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { threadId = null } = useParams({ strict: false }) as { threadId?: string };
  const search = useSearch({ strict: false }) as MailSearch;
  const account = useGoogleAccount();
  const connected = !!account.data;
  const twoUp = useMediaQuery(MAIL_TWO_UP_QUERY);
  const projects = useProjects().data;
  const { filters, noProject } = filtersOf(search, projects);
  const threads = useMailThreads(filters, { enabled: connected && projects !== undefined });
  const allRows = useMailThreads({}, { enabled: connected }).data;
  const boxes = useMailboxes().data ?? [];
  const drafts = useMailDrafts().data;
  const opened = useMailThread(connected ? threadId : null);
  const listRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const setSearch = (patch: Partial<MailSearch>) =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      replace: true,
    } as never);
  const setSearchRef = useRef(setSearch);
  setSearchRef.current = setSearch;

  // Cambio di persona: ricerca e casella della persona di prima non restano.
  useEffect(
    () =>
      onBeforePersonaChange(() => {
        switchedPersona.current = true;
        setSearchRef.current({ q: undefined, mailbox: undefined });
      }),
    [switchedPersona],
  );
  useEffect(() => {
    if (!switchedPersona.current) return;
    if (threadId && opened.isPending) return;
    switchedPersona.current = false;
    if (threadId && opened.isError) {
      void navigate({ to: "/mail", search: (prev: Record<string, unknown>) => prev as never, replace: true });
    }
  }, [opened.isPending, opened.isError, threadId, navigate, switchedPersona]);

  // ⌘F cerca nella posta (solo qui: la pagina è montata).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!hasModKey(e) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "f") return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rows = useMemo(
    () => (threads.data && noProject ? withoutProject(threads.data) : threads.data),
    [threads.data, noProject],
  );
  const projectMap = useMemo(
    () => new Map<string, ProjectRef>((projects ?? []).map((p) => [p.id, p])),
    [projects],
  );
  const mailProjects = useMemo(
    () => mailProjectsOf(allRows, projects).map((e) => e.project),
    [allRows, projects],
  );
  // Con una ricerca, il frammento trovato del messaggio più recente di ogni conversazione.
  const found = useMailSearch(search.q ?? "", !!search.q);
  const hits = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of found.data ?? []) if (!map.has(h.threadId)) map.set(h.threadId, h.snippet);
    return map;
  }, [found.data]);
  const draftThreads = useMemo(
    () => new Set((drafts ?? []).flatMap((d) => (d.threadId ? [d.threadId] : []))),
    [drafts],
  );
  const waiting = (allRows ?? []).filter((r) => r.openProposals > 0);

  // Coi tasti (J/K) si scorre: la cronologia non si riempie di conversazioni.
  const open = (id: string, how: "click" | "keys" = "click") =>
    void navigate({
      to: "/mail/$threadId",
      params: { threadId: id },
      search: (prev: Record<string, unknown>) => prev as never,
      replace: how === "keys",
    });
  const backToList = () => {
    if (!twoUp) {
      void navigate({ to: "/mail", search: (prev: Record<string, unknown>) => prev as never });
      return;
    }
    const row = listRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    (row ?? listRef.current)?.focus();
  };

  if (account.isPending) return <section className="h-full" aria-busy="true" />;
  if (!connected) return <ConnectGoogle />;

  const list = (
    <div className={`flex min-h-0 flex-col ${twoUp ? "w-[380px] shrink-0 border-r border-rule" : "min-w-0 flex-1"}`}>
      <header className="shrink-0 px-4 pt-6 pb-3">
        <h1 className="text-2xl font-semibold text-ink">{t("nav.mail")}</h1>
      </header>
      <ThreadList
        search={search}
        setSearch={setSearch}
        rows={rows}
        loading={threads.isPending}
        error={threads.isError}
        onRetry={() => void threads.refetch()}
        projects={projectMap}
        mailProjects={mailProjects}
        boxes={boxes}
        selectedId={threadId}
        drafts={draftThreads}
        onOpen={open}
        onEnter={() => paneRef.current?.focus()}
        listRef={listRef}
        searchRef={searchRef}
        hits={hits}
      />
    </div>
  );

  const pane = threadId ? (
    <ReadingPane
      key={threadId}
      threadId={threadId}
      q={search.q}
      narrow={!twoUp}
      paneRef={paneRef}
      onEscape={backToList}
    />
  ) : (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <p className="text-md text-ink-faint">{t("mail.reading.select")}</p>
      {waiting.length > 0 && (
        <p className="text-sm text-ink-muted">
          {t("mail.reading.waiting", { count: waiting.length })} ·{" "}
          <button
            type="button"
            onClick={() => open(waiting[0]!.threadId)}
            className="rounded-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
          >
            {t("mail.reading.show")}
          </button>
        </p>
      )}
    </div>
  );

  if (!twoUp) {
    return (
      <section data-mail-page="one" className="flex h-full min-h-0 flex-col">
        {threadId ? (
          <>
            <h1 className="sr-only">{t("nav.mail")}</h1>
            <div className="min-h-0 flex-1 overflow-y-auto">{pane}</div>
          </>
        ) : (
          list
        )}
      </section>
    );
  }
  return (
    <section data-mail-page="two" className="flex h-full min-h-0">
      {list}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{pane}</div>
    </section>
  );
}

/** Senza account Google: la pagina intera lo dice, con «Connect Google account» (area 5). */
function ConnectGoogle() {
  const { t } = useTranslation();
  return (
    <section className="flex h-full flex-col">
      <header className="shrink-0 px-8 pt-8">
        <h1 className="text-2xl font-semibold text-ink">{t("nav.mail")}</h1>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 pb-24 text-center">
        <p className="max-w-[52ch] text-md text-ink">{t("mail.connect.body")}</p>
        <button type="button" className={primaryButton} onClick={() => openGoogleAccount()}>
          {t("mail.connect.button")}
        </button>
        <p className="text-xs text-ink-faint">{t("mail.connect.calendar")}</p>
      </div>
    </section>
  );
}
