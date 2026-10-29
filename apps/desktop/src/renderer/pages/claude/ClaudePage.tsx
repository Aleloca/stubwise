import { Navigate, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  useArchiveConversation,
  useContinueConversation,
  useConversation,
  useCreateConversation,
  useDeleteConversation,
  usePeople,
  useProjects,
  useRenameConversation,
  useSetVisibility,
  useTasks,
} from "../../data/queries";
import { CLAUDE_SCOPES, type ClaudeScope } from "../../data/routes";
import type { Attachment, ConversationDetail } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { hasModKey } from "../../platform/platform";
import { formatDate } from "../../notifications/time";
import { Dialog } from "../../tasks-ui/Dialog";
import { MenuGroup, RadioItem, itemClass } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { Chevron, MenuButton, primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import { Conversation, type ContinueHandler } from "./conversation/Conversation";
import { handOffFirstMessage } from "./conversation/handoff";
import { dangerButton } from "../task/parts";
import { ConversationList } from "./ConversationList";
import { StateSign, rowStateLabel, rowStateOf, useKindWord } from "./marks";
import { ObjectSide, hasObject } from "./ObjectSide";
import { PublishDialog } from "./PublishDialog";

/** Evento che rimette il fuoco nella casella dell'atterraggio (N / ⌘N quando ci si è già). */
const FOCUS_NEW_EVENT = "stubwise:claude-new";
/** Da questa larghezza della finestra il lato oggetto si aggancia; sotto è un bottone in testata. */
const SIDE_DOCK_QUERY = "(min-width: 1200px)";

/** Si sta scrivendo: la lettera va al campo, non alla pagina. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

const overlayOpen = () => document.querySelector('[aria-modal="true"], [role="menu"]') !== null;

/**
 * N (o ⌘N) nella destinazione «Claude»: una conversazione nuova. Niente
 * scrivendo, né con un dialogo o un menu aperti.
 */
function useNewConversationKey() {
  const navigate = useNavigate();
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.defaultPrevented || e.altKey || e.shiftKey || e.key.toLowerCase() !== "n") return;
      const mod = hasModKey(e);
      if (!mod && (e.metaKey || e.ctrlKey)) return;
      if (!mod && typing(e.target)) return;
      if (overlayOpen()) return;
      e.preventDefault();
      void navigate({ to: "/claude", search: {} }).then(() =>
        window.dispatchEvent(new CustomEvent(FOCUS_NEW_EVENT)),
      );
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);
}

/**
 * `#/claude`: con `?scope=` uno degli elenchi, senza una conversazione nuova
 * vuota (l'atterraggio: chi arriva qui di solito vuole chiedere). Cambiare
 * persona rimonta tutto: nessuna bozza né filtro della persona di prima.
 */
export function ClaudePage() {
  const { viewer } = useViewer();
  const search = useSearch({ strict: false }) as { scope?: string; ask?: string };
  useNewConversationKey();
  const scope = (CLAUDE_SCOPES as readonly string[]).includes(search.scope ?? "")
    ? (search.scope as ClaudeScope)
    : null;
  if (scope === "public" && !can(viewer, "claude.public.view")) {
    return <Navigate to="/claude" search={{}} replace />;
  }
  if (scope) return <ConversationList key={`${viewer.personId}:${scope}`} scope={scope} />;
  return <NewConversation key={viewer.personId} initial={search.ask ?? ""} />;
}

/**
 * L'atterraggio: h1 «New conversation», la casella grande in alto con il
 * progetto di contesto (facoltativo) e, sotto, quattro suggerimenti come
 * righe di testo. La conversazione nasce al primo invio — una vuota non
 * finisce fra le proprie.
 */
function NewConversation({ initial }: { initial: string }) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const navigate = useNavigate();
  const [text, setText] = useState(initial);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const create = useCreateConversation();
  const projects = useProjects().data ?? [];
  const mine = useTasks({ assigneeIds: [viewer.personId] }).data;
  const hintId = useId();
  const suggestionsId = useId();

  useEffect(() => {
    field.current?.focus();
    const refocus = () => field.current?.focus();
    window.addEventListener(FOCUS_NEW_EVENT, refocus);
    return () => window.removeEventListener(FOCUS_NEW_EVENT, refocus);
  }, []);
  // La domanda portata dalla palette resta nella casella, non nell'indirizzo.
  useEffect(() => {
    if (initial) void navigate({ to: "/claude", search: {}, replace: true });
  }, [initial, navigate]);
  // Il campo cresce con il testo (fino a ~10 righe).
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const start = () => {
    const question = text.trim();
    if (!question || create.isPending) return;
    setFailed(false);
    create.mutate(projectId ? { contextProjectId: projectId } : {}, {
      onSuccess: (c) => {
        // La domanda la manda la conversazione: se non va, resta lì con «Resend».
        handOffFirstMessage(c.id, { text: question, attachments: [] });
        void navigate({ to: "/claude/$id", params: { id: c.id } });
      },
      onError: () => setFailed(true),
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      start();
    }
  };
  const pick = (suggestion: string) => {
    setText(suggestion);
    requestAnimationFrame(() => {
      const el = field.current;
      el?.focus();
      el?.setSelectionRange(suggestion.length, suggestion.length);
    });
  };

  const explainCode = mine?.[0]?.code ?? null;
  const howtoCode = projects.find((p) => p.code === "STW")?.code ?? projects[0]?.code ?? null;
  const suggestions = [
    t("claude.destination.landing.suggest.today"),
    t("claude.destination.landing.suggest.projects"),
    ...(explainCode ? [t("claude.destination.landing.suggest.explain", { code: explainCode })] : []),
    ...(howtoCode
      ? [
          t("claude.destination.landing.suggest.howto", {
            code: howtoCode,
            topic: t("claude.destination.landing.topic"),
          }),
        ]
      : []),
  ];
  const context = projects.find((p) => p.id === projectId) ?? null;

  return (
    <section className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="page-header flex w-full max-w-[784px] flex-col gap-6 pb-10 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-ink">
            {t("claude.destination.landing.title")}
          </h1>
          <p className="max-w-[72ch] text-sm text-ink-muted">
            {t("claude.destination.landing.intro")}
          </p>
        </div>
        <div className="flex min-w-0 flex-col rounded-lg border border-rule-strong bg-surface transition-colors duration-[var(--duration-fast)] ease-out focus-within:border-ink/45">
          <textarea
            ref={field}
            rows={3}
            value={text}
            aria-label={t("claude.destination.landing.label")}
            aria-describedby={hintId}
            placeholder={t("claude.destination.landing.placeholder")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            className="block min-h-[84px] w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-lg text-ink outline-none placeholder:text-ink-faint focus-visible:outline-none"
          />
          <div className="flex min-w-0 items-center gap-2 px-2 pb-2">
            <MenuButton
              menuLabel={t("claude.conversation.context.menu")}
              placement="below"
              className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/8"
              label={
                <>
                  <span className="truncate">
                    {context
                      ? t("claude.conversation.context.project", { code: context.code })
                      : t("claude.conversation.context.none")}
                  </span>
                  <Chevron />
                </>
              }
            >
              {(close) => (
                <MenuGroup>
                  <RadioItem
                    checked={projectId === null}
                    onSelect={() => {
                      setProjectId(null);
                      close();
                    }}
                  >
                    {t("claude.conversation.context.noneItem")}
                  </RadioItem>
                  {projects.map((p) => (
                    <RadioItem
                      key={p.id}
                      checked={projectId === p.id}
                      onSelect={() => {
                        setProjectId(p.id);
                        close();
                      }}
                    >
                      <span className="num w-10 shrink-0 text-xs font-semibold">{p.code}</span>
                      <span className="min-w-0 truncate">{p.name}</span>
                    </RadioItem>
                  ))}
                </MenuGroup>
              )}
            </MenuButton>
            <span id={hintId} className="ml-auto hidden text-xs text-ink-faint sm:inline">
              {t("claude.destination.landing.hint")}
            </span>
            <button
              type="button"
              className={`${primaryButton} disabled:opacity-40`}
              disabled={!text.trim() || create.isPending}
              onClick={start}
            >
              {create.isPending
                ? t("claude.destination.landing.sending")
                : t("claude.destination.landing.send")}
            </button>
          </div>
        </div>
        {failed && (
          <p role="alert" className="-mt-3 text-sm text-critical">
            {t("claude.destination.landing.failed")}
          </p>
        )}
        <div className="flex flex-col">
          <p id={suggestionsId} className="heading-group pb-1.5">
            {t("claude.destination.landing.suggestions")}
          </p>
          <ul aria-labelledby={suggestionsId} className="flex flex-col">
            {suggestions.map((s) => (
              <li key={s} className="border-b border-rule last:border-b-0">
                <button
                  type="button"
                  onClick={() => pick(s)}
                  className="flex h-10 w-full min-w-0 items-center gap-3 rounded-md px-2 text-left text-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 hover:text-ink"
                >
                  <ArrowGlyph />
                  <span className="min-w-0 truncate">{s}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** L'elenco a cui torna Esc da una conversazione: quello da cui, di solito, ci si è arrivati. */
function homeScopeOf(detail: ConversationDetail): ClaudeScope {
  if (detail.kind === "free") return detail.isOwner ? "mine" : "public";
  return detail.state === "finished" ? "finished" : "live";
}

/**
 * `#/claude/<id>`: testata (h1 = titolo, riga meta, «Make public» e «⋯» per
 * l'autore di una libera) e la conversazione; per le sessioni legate a un
 * oggetto, a lato la task o la richiesta (agganciata da 1200 px, sotto un
 * bottone in testata che apre il pannello). Esc torna all'elenco.
 */
export function ConversationPage({ id }: { id: string }) {
  const { viewer } = useViewer();
  return <ConversationPageBody key={`${viewer.personId}:${id}`} id={id} />;
}

function ConversationPageBody({ id }: { id: string }) {
  const navigate = useNavigate();
  const query = useConversation(id);
  const detail = query.data ?? null;
  const docked = useMediaQuery(SIDE_DOCK_QUERY);
  const [sideOpen, setSideOpen] = useState(false);
  const continueConversation = useContinueConversation();
  useNewConversationKey();

  // Esc: chiude il pannello dell'oggetto, se no torna all'elenco.
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const sideOpenRef = useRef(sideOpen);
  sideOpenRef.current = sideOpen;
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented || typing(e.target) || overlayOpen()) return;
      if (sideOpenRef.current) {
        e.preventDefault();
        setSideOpen(false);
        return;
      }
      const d = detailRef.current;
      if (!d) return;
      e.preventDefault();
      void navigate({ to: "/claude", search: { scope: homeScopeOf(d) } });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  const onContinue: ContinueHandler = async (text: string, attachments: Attachment[]) => {
    const next = await continueConversation.mutateAsync(id);
    handOffFirstMessage(next.id, { text, attachments });
    void navigate({ to: "/claude/$id", params: { id: next.id } });
  };

  const withSide = detail !== null && hasObject(detail);
  return (
    <section className="relative flex h-full min-h-0 flex-col">
      {detail && (
        <PageHeader
          detail={detail}
          sideToggle={
            withSide && !docked ? { open: sideOpen, toggle: () => setSideOpen((o) => !o) } : null
          }
        />
      )}
      <div className="edit-enter relative min-h-0 flex-1">
        <Conversation
          id={id}
          {...(withSide && docked ? { side: <ObjectSide detail={detail} /> } : {})}
          onContinue={onContinue}
        />
        {withSide && !docked && sideOpen && (
          <div className="panel-enter absolute inset-y-0 right-0 z-20 w-[360px] max-w-full overflow-y-auto border-l border-rule-strong bg-surface">
            <ObjectSide detail={detail} onClose={() => setSideOpen(false)} />
          </div>
        )}
      </div>
    </section>
  );
}

/** La testata della pagina: h1 (rinominabile sul posto), riga meta, azioni dell'autore. */
function PageHeader({
  detail,
  sideToggle,
}: {
  detail: ConversationDetail;
  sideToggle: { open: boolean; toggle: () => void } | null;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const people = usePeople().data;
  const projects = useProjects().data;
  const kindWord = useKindWord();
  const rename = useRenameConversation();
  const archive = useArchiveConversation();
  const remove = useDeleteConversation();
  const setVisibility = useSetVisibility();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(detail.title);
  const [publishing, setPublishing] = useState<null | "publish" | "reconfirm">(null);
  const [deleting, setDeleting] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const title = detail.title || t("claude.destination.page.untitled");
  const projectCode = (id: string | null) => projects?.find((p) => p.id === id)?.code ?? null;
  const nameOf = (id: string | null) => people?.find((p) => p.id === id)?.name ?? "";
  const free = detail.kind === "free";
  const isPublic = free && detail.visibility === "public";
  const state = rowStateOf(detail);

  const startRename = () => {
    setDraft(detail.title);
    setEditing(true);
  };
  const finishRename = (save: boolean) => {
    setEditing(false);
    requestAnimationFrame(() => titleRef.current?.focus());
    const next = draft.trim();
    if (!save || !next || next === detail.title) return;
    rename.mutate(
      { id: detail.id, title: next },
      { onError: () => toast.error(t("claude.destination.page.renameFailed")) },
    );
  };
  const setArchived = (archived: boolean, withUndo: boolean) =>
    archive.mutate(
      { id: detail.id, archived },
      {
        onSuccess: () =>
          toast.show(
            t(archived ? "claude.destination.page.archived" : "claude.destination.page.restored"),
            withUndo
              ? {
                  action: {
                    label: t("claude.destination.page.undo"),
                    run: () => setArchived(!archived, false),
                  },
                }
              : {},
          ),
        onError: () => toast.error(t("claude.destination.page.archiveFailed")),
      },
    );
  const makePrivate = () =>
    setVisibility.mutate(
      { id: detail.id, visibility: "private" },
      {
        onSuccess: () => toast.show(t("claude.destination.page.madePrivate")),
        onError: () => toast.error(t("claude.destination.page.publishFailed")),
      },
    );
  const confirmDelete = () =>
    remove.mutate(detail.id, {
      onSuccess: () => {
        setDeleting(false);
        toast.show(t("claude.destination.page.deleted"));
        void navigate({ to: "/claude", search: { scope: "mine" } });
      },
      onError: () => toast.error(t("claude.destination.page.deleteFailed")),
    });

  // La riga meta: cosa è e dove; per le sessioni, l'oggetto e lo stato in parola.
  const context = projectCode(detail.projectId ?? detail.contextProjectId);
  const unconfirmed =
    detail.isOwner && detail.privateFromIndex !== null
      ? detail.touchedProjectIds
          .filter((p) => !detail.publishedProjectIds.includes(p))
          .map((p) => projectCode(p))
          .filter(Boolean)
      : [];

  return (
    <header className="page-header flex shrink-0 flex-col gap-1.5 border-b border-rule pb-3 pl-8 [--page-header-pr:32px] [--page-header-pt:28px]">
      <div className="flex min-w-0 items-center gap-3">
        {editing ? (
          <input
            autoFocus
            aria-label={t("claude.destination.page.renameLabel")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => finishRename(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                finishRename(true);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                finishRename(false);
              }
            }}
            className="-ml-2 h-[38px] min-w-0 flex-1 rounded-md border border-rule-strong bg-surface px-2 text-2xl font-semibold text-ink outline-none focus-visible:border-ink/45"
          />
        ) : (
          <h1
            ref={titleRef}
            tabIndex={-1}
            title={title}
            className="min-w-0 flex-1 truncate text-2xl font-semibold text-ink outline-none"
          >
            {title}
          </h1>
        )}
        <div className="flex shrink-0 items-center gap-2">
          {sideToggle && (
            <button
              type="button"
              aria-expanded={sideToggle.open}
              className={secondaryButton}
              onClick={sideToggle.toggle}
            >
              {detail.taskId
                ? t("claude.destination.page.objectTask", { code: detail.objectCode ?? "" })
                : t("claude.destination.page.objectRequest", { code: detail.objectCode ?? "" })}
            </button>
          )}
          {free && detail.canManage && !detail.archived && (
            <button
              type="button"
              className={secondaryButton}
              onClick={() => (isPublic ? makePrivate() : setPublishing("publish"))}
            >
              {isPublic
                ? t("claude.destination.page.makePrivate")
                : t("claude.destination.page.makePublic")}
            </button>
          )}
          {free && detail.canManage && (
            <span className="inline-flex">
              <MenuButton
                menuLabel={t("claude.destination.page.more")}
                ariaLabel={t("claude.destination.page.more")}
                title={t("claude.destination.page.more")}
                align="right"
                className={`${quietButton} w-8 justify-center px-0`}
                label={<MoreGlyph />}
              >
                {(close) => (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className={itemClass}
                      onClick={() => {
                        close();
                        startRename();
                      }}
                    >
                      {t("claude.destination.page.rename")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className={itemClass}
                      onClick={() => {
                        close();
                        setArchived(!detail.archived, !detail.archived);
                      }}
                    >
                      {detail.archived
                        ? t("claude.destination.page.restore")
                        : t("claude.destination.page.archive")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className={`${itemClass} text-critical`}
                      onClick={() => {
                        close();
                        setDeleting(true);
                      }}
                    >
                      {t("claude.destination.page.delete")}
                    </button>
                  </>
                )}
              </MenuButton>
            </span>
          )}
        </div>
      </div>
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-ink-muted">
        {free ? (
          isPublic ? (
            <span data-public-line>
              {t("claude.destination.page.publicBy", {
                name: nameOf(detail.publishedById),
                date: detail.publishedAt ? formatDate(detail.publishedAt, i18n.language) : "",
              })}
            </span>
          ) : (
            <span>{t("claude.destination.page.private")}</span>
          )
        ) : (
          <>
            <span>{kindWord(detail.kind)}</span>
            {/* L'analisi di un server: automatica, con il solo accesso di lettura. */}
            {detail.serverAnalysis && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {t("claude.destination.page.automaticServer", {
                    code: detail.serverAnalysis.serverCode,
                  })}
                </span>
              </>
            )}
            {detail.objectCode && (
              <>
                <span aria-hidden="true">·</span>
                <span className="num text-xs font-semibold tracking-[0.02em] text-ink">
                  {detail.objectCode}
                </span>
              </>
            )}
          </>
        )}
        {context && (
          <>
            <span aria-hidden="true">·</span>
            <span>{t("claude.destination.page.project", { code: context })}</span>
          </>
        )}
        {state && state !== "public" && state !== "archived" && (
          <>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1.5">
              <StateSign state={state} />
              {rowStateLabel(state, t)}
            </span>
          </>
        )}
        {detail.archived && (
          <>
            <span aria-hidden="true">·</span>
            <span>{t("claude.destination.page.archivedNote")}</span>
          </>
        )}
      </p>
      {unconfirmed.length > 0 && (
        <div
          role="status"
          className="mt-1.5 flex max-w-[784px] flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-ink/5 px-3 py-2 text-sm text-ink"
        >
          <span className="min-w-0 flex-1">
            {t("claude.destination.page.reconfirm", { codes: unconfirmed.join(", ") })}
          </span>
          <button type="button" className={secondaryButton} onClick={() => setPublishing("reconfirm")}>
            {t("claude.destination.page.reconfirmAction")}
          </button>
        </div>
      )}
      {publishing && (
        <PublishDialog
          detail={detail}
          reconfirm={publishing === "reconfirm"}
          onClose={() => setPublishing(null)}
          onDone={() => {
            setPublishing(null);
            toast.show(t("claude.destination.page.madePublic"));
          }}
        />
      )}
      {deleting && (
        <Dialog
          title={t("claude.destination.page.deleteTitle", { title })}
          width={480}
          onClose={() => setDeleting(false)}
          footer={
            <>
              <button
                type="button"
                data-autofocus
                className={secondaryButton}
                onClick={() => setDeleting(false)}
              >
                {t("claude.destination.page.cancel")}
              </button>
              <button
                type="button"
                className={`${dangerButton} h-8 px-3 disabled:opacity-40`}
                disabled={remove.isPending}
                onClick={confirmDelete}
              >
                {t("claude.destination.page.delete")}
              </button>
            </>
          }
        >
          <p className="text-md text-ink-muted">{t("claude.destination.page.deleteBody")}</p>
        </Dialog>
      )}
    </header>
  );
}

function MoreGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true" focusable="false">
      <circle cx="3.5" cy="8" r="1.25" fill="currentColor" />
      <circle cx="8" cy="8" r="1.25" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.25" fill="currentColor" />
    </svg>
  );
}

function ArrowGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-ink-faint"
    >
      <path d="M3 8h9m0 0L8.5 4.5M12 8l-3.5 3.5" />
    </svg>
  );
}
