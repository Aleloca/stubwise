import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  useMailProposals,
  useMailThread,
  useMarkMailRead,
  useMarkMailUnread,
  usePeople,
  useProjects,
  useReproposeMessage,
  useSessionPersonId,
} from "../../data/queries";
import type { MailMessageView, MailProposalView, MailThreadDetail, Project } from "../../data/types";
import { useToast } from "../../tasks-ui/Toast";
import { itemClass } from "../../tasks-ui/Menu";
import { typing } from "../tasks/useTaskKeys";
import { MenuButton } from "../tasks/controls";
import { fold, searchWords } from "../chat/search";
import { ArrowLeftGlyph, MoreGlyph } from "./glyphs";
import { MailProposalCard } from "./MailProposalCard";
import { MessageView } from "./MessageView";
import { DueLabel } from "./ThreadRow";

// Il pannello di lettura (shape mail.md §3, §5): la testata della
// conversazione (oggetto per intero, A7), poi i messaggi — espansi i non
// letti, l'ultimo e quello cercato, gli altri righe chiuse; oltre 6 chiusi
// di fila una fascia «N earlier messages» (A10) — con le schede delle
// proposte subito sotto il messaggio da cui nascono. La conversazione si
// segna letta dopo 1 s di permanenza (A19), non al passaggio rapido.

/** Oltre questi messaggi chiusi consecutivi, una fascia li raccoglie. */
export const COLLAPSE_RUN = 6;
/** La permanenza che segna letta una conversazione. */
export const READ_AFTER_MS = 1000;

const matches = (m: MailMessageView, words: string[]) =>
  words.length > 0 && words.every((w) => fold(`${m.subject}\n${m.from.name} ${m.from.email}\n${m.text}`).includes(w));

/** I messaggi aperti all'arrivo: i non letti, l'ultimo e quelli cercati. */
function initiallyOpen(thread: MailThreadDetail, q: string | undefined): Set<string> {
  const words = q ? searchWords(q) : [];
  const open = new Set<string>();
  thread.messages.forEach((m, i) => {
    if (!m.read || i === thread.messages.length - 1 || matches(m, words)) open.add(m.id);
  });
  return open;
}

type Item = { kind: "message"; message: MailMessageView } | { kind: "band"; ids: string[] };

export function ReadingPane({
  threadId,
  q,
  narrow,
  paneRef,
  onEscape,
}: {
  threadId: string;
  q: string | undefined;
  /** Uno per volta (finestra stretta): «← Mail» in testa. */
  narrow: boolean;
  paneRef: RefObject<HTMLDivElement | null>;
  onEscape: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const me = useSessionPersonId();
  const thread = useMailThread(threadId);
  const proposals = useMailProposals({});
  const peopleList = usePeople().data;
  const projects = useProjects().data;
  const markRead = useMarkMailRead();
  const markUnread = useMarkMailUnread();
  const repropose = useReproposeMessage();

  const people = useMemo(() => new Map((peopleList ?? []).map((p) => [p.id, p])), [peopleList]);
  const projectById = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p])), [projects]);

  // Aperti all'arrivo, fissati alla prima lettura: segnare letto non li richiude.
  const initial = useRef<Set<string> | null>(null);
  const found = useRef<Set<string>>(new Set());
  if (thread.data && !initial.current) {
    initial.current = initiallyOpen(thread.data, q);
    const words = q ? searchWords(q) : [];
    found.current = new Set(thread.data.messages.filter((m) => matches(m, words)).map((m) => m.id));
  }
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());
  const [bandsOpen, setBandsOpen] = useState(false);
  const [originals, setOriginals] = useState<ReadonlySet<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const keptUnread = useRef(false);
  const isOpen = (id: string) => toggled.get(id) ?? initial.current?.has(id) ?? false;
  const toggle = (id: string) => setToggled((m) => new Map(m).set(id, !isOpen(id)));

  // Letta dopo 1 s di permanenza; «Mark as unread» la lascia com'è finché non si riapre.
  const hasUnread = !!thread.data?.messages.some((m) => !m.read);
  const markReadMutate = markRead.mutate;
  useEffect(() => {
    if (!hasUnread || keptUnread.current) return;
    const timer = window.setTimeout(() => markReadMutate(threadId), READ_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [hasUnread, threadId, markReadMutate]);

  const bySource = useMemo(() => {
    const map = new Map<string, MailProposalView[]>();
    for (const v of proposals.data ?? []) {
      if (v.proposal.source === "calendar") continue;
      const list = map.get(v.proposal.sourceId) ?? [];
      list.push(v);
      map.set(v.proposal.sourceId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.proposal.createdAt.localeCompare(b.proposal.createdAt));
    return map;
  }, [proposals.data]);

  if (thread.isPending) return <PaneSkeleton />;
  if (thread.isError || !thread.data) {
    return (
      <div className="flex flex-col items-start gap-3 px-8 py-10">
        {narrow && <BackLink />}
        <p role="alert" className="text-md text-ink">
          {t("mail.reading.notFound")}
        </p>
      </div>
    );
  }
  const data = thread.data;
  const messages = data.messages;
  const last = messages[messages.length - 1]!;
  const done = messages.flatMap((m) => (m.classification.state === "done" ? [m.classification] : []));
  const threadProjects = [...new Set(done.flatMap((c) => c.projectIds))].flatMap((id) => {
    const p = projectById.get(id);
    return p ? [p] : [];
  });
  // L'importanza della conversazione: la più alta fra i messaggi classificati.
  const importance = (["high", "normal", "low"] as const).find((level) =>
    done.some((c) => c.importance === level),
  );
  const due = done.flatMap((c) => (c.dueDate ? [c.dueDate] : [])).sort()[0];
  const threadProposals = messages.flatMap((m) => bySource.get(m.messageId) ?? []);
  const notAboutProjects =
    done.length > 0 &&
    done.every((c) => c.projectIds.length === 0 && c.uncertainProjectIds.length === 0) &&
    threadProposals.length === 0;
  const failed = messages.find((m) => m.classification.state === "failed");
  const singleProject = threadProjects.length === 1 ? threadProjects[0]!.id : null;

  // I messaggi, con le fasce al posto dei chiusi oltre i 6 di fila.
  const items: Item[] = [];
  let run: MailMessageView[] = [];
  const flush = () => {
    if (run.length > COLLAPSE_RUN && !bandsOpen) items.push({ kind: "band", ids: run.map((m) => m.id) });
    else for (const m of run) items.push({ kind: "message", message: m });
    run = [];
  };
  for (const m of messages) {
    if (isOpen(m.id) || bySource.has(m.messageId)) {
      flush();
      items.push({ kind: "message", message: m });
    } else run.push(m);
  }
  flush();

  const recipientsOf = (m: MailMessageView) =>
    [m.from, ...m.to, ...(m.cc ?? [])].flatMap((a) => (a.personId && a.personId !== me ? [a.personId] : []));
  const alsoFor = (m: MailMessageView, project: Project | undefined) =>
    [...new Set(recipientsOf(m))]
      .filter((id) => project?.memberIds.includes(id))
      .map((id) => people.get(id)?.name ?? id);
  const nothingFor = (m: MailMessageView) => {
    if (m.classification.state !== "done") return [];
    const own = bySource.get(m.messageId) ?? [];
    return m.classification.projectIds
      .filter((id) => !own.some((v) => v.proposal.projectId === id))
      .flatMap((id) => {
        const p = projectById.get(id);
        return p ? [p.code] : [];
      });
  };

  // N/P: messaggio successivo/precedente (si apre); O apre o chiude; U non letta; Esc all'elenco.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    if ((e.target as HTMLElement).closest("[data-mail-proposal], [role=menu]")) {
      if (e.key === "Escape") return;
    }
    const ids = messages.map((m) => m.id);
    const at = Math.max(0, ids.indexOf(current ?? last.id));
    const go = (index: number) => {
      const id = ids[Math.min(ids.length - 1, Math.max(0, index))]!;
      setBandsOpen(true);
      setToggled((m) => new Map(m).set(id, true));
      setCurrent(id);
      requestAnimationFrame(() =>
        paneRef.current?.querySelector<HTMLElement>(`[data-message="${CSS.escape(id)}"] button`)?.focus(),
      );
    };
    switch (e.key.toLowerCase()) {
      case "n":
        e.preventDefault();
        go(at + 1);
        return;
      case "p":
        e.preventDefault();
        go(at - 1);
        return;
      case "o": {
        e.preventDefault();
        const id = current ?? last.id;
        toggle(id);
        return;
      }
      case "u":
        e.preventDefault();
        unread();
        return;
      case "escape":
        e.preventDefault();
        onEscape();
        return;
    }
  }

  function unread() {
    keptUnread.current = true;
    markUnread.mutate(threadId);
  }

  return (
    <div
      ref={paneRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-reading-pane={threadId}
      className="mx-auto flex w-full max-w-[824px] min-w-0 flex-col px-8 pt-6 pb-16 outline-none"
    >
      {narrow && <BackLink />}
      <header className="flex min-w-0 flex-col gap-2 border-b border-rule pb-4">
        <div className="flex min-w-0 items-start gap-3">
          <h2
            className={`min-w-0 flex-1 text-xl leading-[26px] font-semibold [overflow-wrap:anywhere] ${data.subject ? "text-ink" : "text-ink-faint"}`}
          >
            {data.subject || t("mail.row.noSubject")}
          </h2>
          <MenuButton
            menuLabel={t("mail.reading.more")}
            ariaLabel={t("mail.reading.more")}
            align="right"
            className="grid size-8 shrink-0 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/10"
            label={<MoreGlyph />}
          >
            {(close) => (
              <>
                <button type="button" role="menuitem" tabIndex={-1} className={itemClass} onClick={() => (close(), toast.show(t("mail.gmailNotice")))}>
                  {t("mail.reading.openInGmail")}
                </button>
                <button type="button" role="menuitem" tabIndex={-1} className={itemClass} onClick={() => (close(), unread())}>
                  {t("mail.reading.markUnread")}
                  <kbd aria-hidden="true" className="num ml-auto text-xs text-ink-faint">U</kbd>
                </button>
                {failed && (
                  <button type="button" role="menuitem" tabIndex={-1} className={itemClass} onClick={() => (close(), repropose.mutate(failed.id))}>
                    {t("mail.repropose")}
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={itemClass}
                  onClick={() => {
                    close();
                    void navigator.clipboard?.writeText(`#/mail/${threadId}`).catch(() => undefined);
                    toast.show(t("mail.reading.linkCopied"));
                  }}
                >
                  {t("mail.reading.copyLink")}
                </button>
              </>
            )}
          </MenuButton>
        </div>
        <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-sm text-ink-muted">
          {threadProjects.map((p) => (
            <Link
              key={p.id}
              to="/p/$code"
              params={{ code: p.code }}
              className="rounded-sm underline decoration-ink/20 underline-offset-2 hover:decoration-ink"
            >
              <span className="num font-semibold tracking-[0.02em] text-ink">{p.code}</span>{" "}
              <span className="text-ink">{p.name}</span>
            </Link>
          ))}
          {importance && importance !== "normal" && (
            <span>
              {threadProjects.length > 0 && <span aria-hidden="true">· </span>}
              {t(`mail.importance.${importance}`)}
            </span>
          )}
          {due && (
            <span className="num">
              {(threadProjects.length > 0 || (importance && importance !== "normal")) && (
                <span aria-hidden="true">· </span>
              )}
              <DueLabel date={due} long />
            </span>
          )}
        </p>
        {notAboutProjects && <p className="text-xs text-ink-faint">{t("mail.reading.noProject")}</p>}
      </header>
      <div className="flex min-w-0 flex-col">
        {items.map((item) =>
          item.kind === "band" ? (
            <button
              key={`band-${item.ids[0]}`}
              type="button"
              onClick={() => setBandsOpen(true)}
              className="my-1 flex h-9 items-center justify-center rounded-md border border-rule text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
            >
              {t("mail.reading.earlier", { count: item.ids.length })}
            </button>
          ) : (
            <Fragment key={item.message.id}>
              <MessageView
                message={item.message}
                expanded={isOpen(item.message.id)}
                onToggle={() => {
                  setCurrent(item.message.id);
                  toggle(item.message.id);
                }}
                found={found.current.has(item.message.id)}
                people={people}
                projectId={singleProject}
                nothingFor={nothingFor(item.message)}
                onRepropose={() => repropose.mutate(item.message.id)}
                reproposing={repropose.isPending && repropose.variables === item.message.id}
                original={originals.has(item.message.id)}
                onOriginal={(on) =>
                  setOriginals((s) => {
                    const next = new Set(s);
                    if (on) next.add(item.message.id);
                    else next.delete(item.message.id);
                    return next;
                  })
                }
              >
                {isOpen(item.message.id) &&
                  (bySource.get(item.message.messageId) ?? []).map((v) => (
                    <MailProposalCard
                      key={v.proposal.id}
                      view={v}
                      alsoFor={alsoFor(item.message, projectById.get(v.proposal.projectId))}
                    />
                  ))}
              </MessageView>
            </Fragment>
          ),
        )}
      </div>
    </div>
  );
}

function BackLink() {
  const { t } = useTranslation();
  return (
    <Link
      to="/mail"
      search={(prev: Record<string, unknown>) => prev as never}
      className="mb-4 inline-flex h-8 items-center gap-1.5 self-start rounded-md px-2 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
    >
      <ArrowLeftGlyph />
      {t("mail.reading.back")}
    </Link>
  );
}

/** Testata e due messaggi scheletro. */
function PaneSkeleton() {
  const { t } = useTranslation();
  const bar = "block rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe mx-auto flex w-full max-w-[824px] flex-col gap-6 px-8 pt-6">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      <span className={`${bar} h-5 w-2/3`} />
      <span className={`${bar} h-3 w-1/3`} />
      {[0, 1].map((i) => (
        <div key={i} className="flex gap-3">
          <span className="size-8 shrink-0 rounded-full bg-ink/8" />
          <div className="flex flex-1 flex-col gap-2">
            <span className={`${bar} h-3 w-40`} />
            <span className={`${bar} h-3 w-full`} />
            <span className={`${bar} h-3 w-5/6`} />
          </div>
        </div>
      ))}
    </div>
  );
}
