import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  useDeleteFailedMailSend,
  useMailDrafts,
  useMailProposals,
  useMailThread,
  useMarkMailRead,
  useMarkMailUnread,
  usePeople,
  useProjects,
  useReproposeMessage,
  useRetryMailSend,
} from "../../data/queries";
import type {
  MailDraft,
  MailMessageView,
  MailProposalView,
  MailThreadDetail,
} from "../../data/types";
import { useToast } from "../../tasks-ui/Toast";
import { itemClass } from "../../tasks-ui/Menu";
import { typing } from "../tasks/useTaskKeys";
import { MenuButton } from "../tasks/controls";
import { fold, searchWords } from "../chat/search";
import { ArrowLeftGlyph, MoreGlyph } from "./glyphs";
import { Composer } from "./Composer";
import { closeComposer, onComposeRequest, takeCompose, type ComposeRequest } from "./composeRequest";
import { useDiscardedNotice, useDroppedNotice, useUndoSendToast } from "./UndoSendToast";
import { MailProposalCard } from "./MailProposalCard";
import { isLiveProposal } from "./proposalText";
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

/**
 * I messaggi aperti all'arrivo: i non letti, l'ultimo, quelli cercati e
 * quelli con una proposta che aspetta chi guarda (la scheda si vede subito).
 */
function initiallyOpen(
  thread: MailThreadDetail,
  q: string | undefined,
  live: ReadonlySet<string>,
): Set<string> {
  const words = q ? searchWords(q) : [];
  const open = new Set<string>();
  thread.messages.forEach((m, i) => {
    if (!m.read || i === thread.messages.length - 1 || matches(m, words) || live.has(m.messageId)) {
      open.add(m.id);
    }
  });
  return open;
}

type Item = { kind: "message"; message: MailMessageView } | { kind: "band"; ids: string[] };

type ReplyMode = Exclude<MailDraft["mode"], "new">;
const REPLY_MODES: { mode: ReplyMode; key: string }[] = [
  { mode: "reply", key: "R" },
  { mode: "replyAll", key: "A" },
  { mode: "forward", key: "F" },
];

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
  const thread = useMailThread(threadId);
  const proposals = useMailProposals({});
  const peopleList = usePeople().data;
  const projects = useProjects().data;
  const markRead = useMarkMailRead();
  const markUnread = useMarkMailUnread();
  const repropose = useReproposeMessage();
  const drafts = useMailDrafts();
  const retry = useRetryMailSend();
  const removeFailed = useDeleteFailedMailSend();
  const showUndo = useUndoSendToast();
  const droppedNotice = useDroppedNotice();
  const discardedNotice = useDiscardedNotice();

  // La casella di scrittura in fondo (shape mail-compose): una per
  // conversazione; si riapre da sé se c'è una bozza (senza prendere il
  // fuoco), o su richiesta (R/A/F dall'elenco, «Undo», «Edit»).
  const [compose, setCompose] = useState<{ mode: ReplyMode; focus: ComposeRequest["focus"] | "none" } | null>(
    null,
  );
  const replyButtons = useRef(new Map<ReplyMode, HTMLButtonElement>());
  const opener = useRef<ReplyMode | null>(null);
  const draftChecked = useRef(false);
  const focusSent = useRef<string | null>(null);
  const focusComposerBody = () =>
    requestAnimationFrame(() =>
      paneRef.current?.querySelector<HTMLElement>("[data-composer] textarea")?.focus(),
    );
  const openCompose = (mode: ReplyMode, focus: ComposeRequest["focus"] | "none") => {
    opener.current = mode;
    if (compose) {
      setCompose({ mode, focus: compose.focus });
      if (focus !== "none") focusComposerBody();
    } else setCompose({ mode, focus });
  };
  const takeRequest = (req: ComposeRequest | null) => {
    if (!req || req.mode === "new") return false;
    openCompose(req.mode, req.focus);
    return true;
  };
  const takeRef = useRef(takeRequest);
  takeRef.current = takeRequest;
  useEffect(
    () =>
      onComposeRequest((req) => {
        if (req.threadId === threadId) takeRef.current(takeCompose(threadId));
      }),
    [threadId],
  );
  // All'arrivo: una richiesta in attesa, o la bozza salvata della conversazione.
  useEffect(() => {
    if (draftChecked.current || !drafts.data) return;
    draftChecked.current = true;
    if (takeRef.current(takeCompose(threadId))) return;
    const saved = drafts.data.find((d) => d.threadId === threadId);
    if (saved && saved.mode !== "new") setCompose({ mode: saved.mode, focus: "none" });
  }, [drafts.data, threadId]);

  const people = useMemo(() => new Map((peopleList ?? []).map((p) => [p.id, p])), [peopleList]);
  const projectById = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p])), [projects]);

  // Aperti all'arrivo, fissati alla prima lettura (messaggi e proposte):
  // segnare letto o decidere non li richiude.
  const initial = useRef<Set<string> | null>(null);
  const known = useRef<Set<string>>(new Set());
  const found = useRef<Set<string>>(new Set());
  // Le proposte che non si leggono non chiudono i messaggi: si apre come senza proposte.
  if (thread.data && !proposals.isPending && !initial.current) {
    const live = new Set((proposals.data ?? []).filter(isLiveProposal).map((v) => v.proposal.sourceId));
    initial.current = initiallyOpen(thread.data, q, live);
    known.current = new Set(thread.data.messages.map((m) => m.id));
    const words = q ? searchWords(q) : [];
    found.current = new Set(thread.data.messages.filter((m) => matches(m, words)).map((m) => m.id));
  }
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());
  const [bandsOpen, setBandsOpen] = useState(false);
  const [originals, setOriginals] = useState<ReadonlySet<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const keptUnread = useRef(false);
  // Un messaggio arrivato dopo la prima lettura (un mio invio) si apre.
  const isOpen = (id: string) =>
    toggled.get(id) ?? (initial.current ? initial.current.has(id) || !known.current.has(id) : false);
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

  // Dopo l'invio il fuoco va sul messaggio inviato, appena c'è.
  useEffect(() => {
    const id = focusSent.current;
    if (!id || !thread.data?.messages.some((m) => m.id === id)) return;
    focusSent.current = null;
    requestAnimationFrame(() =>
      paneRef.current?.querySelector<HTMLElement>(`[data-message="${CSS.escape(id)}"] button`)?.focus(),
    );
  }, [thread.data, paneRef]);

  if (thread.isPending || (thread.data && proposals.isPending)) return <PaneSkeleton />;
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
    // Dentro una scheda o un menu i tasti sono loro (Space, E, ⌘Enter, Esc).
    // Nella casella di scrittura i tasti sono suoi (Esc la chiude).
    if ((e.target as HTMLElement).closest("[data-mail-proposal], [role=menu], [data-composer]")) return;
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
      case "r":
      case "a":
      case "f": {
        e.preventDefault();
        const mode = REPLY_MODES.find((m) => m.key === e.key.toUpperCase())!.mode;
        openCompose(mode, "start");
        return;
      }
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

  const closeCompose = () => {
    const mode = opener.current ?? compose?.mode ?? "reply";
    setCompose(null);
    requestAnimationFrame(() => replyButtons.current.get(mode)?.focus());
  };

  /**
   * Un mio invio fallito: «Retry» (di nuovo i 5 s con «Undo»), «Edit»
   * (toglie il tentativo e riapre la casella col testo intatto), «Delete»
   * (toglie il tentativo, la bozza resta). La casella aperta salva prima.
   */
  const deliveryOf = (m: MailMessageView) =>
    m.delivery?.state === "failed"
      ? {
          busy: retry.isPending || removeFailed.isPending,
          onRetry: () =>
            void retry
              .mutateAsync(m.id)
              .then((result) => showUndo(result, [...m.to, ...(m.cc ?? [])], false))
              .catch(() => toast.error(t("mail.compose.couldntSend", { reason: t("mail.compose.reason.other") }))),
          onEdit: () =>
            void closeComposer(threadId)
              .then(() => removeFailed.mutateAsync(m.id))
              .then((restored) => {
                droppedNotice(restored);
                if (restored.draft.mode !== "new") openCompose(restored.draft.mode, "body");
              })
              .catch(() => toast.error(t("mail.compose.actionFailed"))),
          onDelete: () =>
            void closeComposer(threadId)
              .then(() => removeFailed.mutateAsync(m.id))
              .then(droppedNotice)
              .catch(() => toast.error(t("mail.compose.actionFailed"))),
        }
      : undefined;

  const composer = compose && (
    <div className="mt-6 flex min-w-0 flex-col gap-3">
      <Composer
        threadId={threadId}
        mode={compose.mode}
        onModeChange={(mode) => {
          if (mode === "new") return;
          opener.current = mode;
          setCompose((c) => (c ? { ...c, mode } : c));
        }}
        messages={messages}
        threadProjects={threadProjects}
        focus={compose.focus}
        onClose={closeCompose}
        onDiscarded={(snapshot) => {
          setCompose(null);
          discardedNotice(snapshot);
        }}
        onSent={(result, recipients) => {
          setCompose(null);
          focusSent.current = result.messageId;
          showUndo(result, recipients, false);
        }}
        header={
          narrow ? (
            <button
              type="button"
              onClick={closeCompose}
              className="inline-flex h-8 items-center gap-1.5 self-start rounded-md px-2 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
            >
              <ArrowLeftGlyph />
              {t("mail.compose.back")}
            </button>
          ) : undefined
        }
      />
    </div>
  );

  if (narrow && composer) {
    return (
      <div
        ref={paneRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-reading-pane={threadId}
        className="mx-auto flex w-full max-w-[824px] min-w-0 flex-col px-8 pt-6 pb-16 outline-none"
      >
        {composer}
      </div>
    );
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
          <div className="flex shrink-0 items-center gap-1">
            {REPLY_MODES.map(({ mode, key }) => (
              <button
                key={mode}
                ref={(el) => {
                  if (el) replyButtons.current.set(mode, el);
                  else replyButtons.current.delete(mode);
                }}
                type="button"
                aria-pressed={compose?.mode === mode}
                title={`${t(`mail.compose.${mode}`)} (${key})`}
                onClick={() => openCompose(mode, "start")}
                className={`inline-flex h-8 shrink-0 items-center rounded-md px-2.5 text-sm font-medium transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-pressed:bg-ink/10 aria-pressed:text-ink ${
                  mode === "reply" ? "border border-rule-strong text-ink" : "text-ink-muted"
                }`}
              >
                {t(`mail.compose.${mode}`)}
              </button>
            ))}
          </div>
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
                delivery={deliveryOf(item.message)}
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
                    <MailProposalCard key={v.proposal.id} view={v} />
                  ))}
              </MessageView>
            </Fragment>
          ),
        )}
      </div>
      {composer}
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
