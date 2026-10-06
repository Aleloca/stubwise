import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSuspenseQuery } from "@tanstack/react-query";
import { plainExcerpt, workStateFor } from "@stubwise/shared";
import type { ActivityComment, ActivityEvent, ActivityAiJob, CommentReplyTo } from "../lib/api";
import { activityQueryOptions } from "../lib/queries";
import { formatDateTime, formatRelativeTime } from "../lib/format";
import {
  PRIORITY_LABEL_KEYS,
  STATUS_LABEL_KEYS,
  TYPE_LABEL_KEYS,
  WORK_STATE_LABEL_KEYS,
  WORK_STATE_TEXT_CLASS,
} from "./badges";
import { Avatar } from "./avatar";
import { ConfirmDeleteButton } from "./confirm-delete-button";
import { FormError } from "./field";
import { Markdown } from "./markdown";
import { MarkdownEditor } from "./markdown-editor";

/** Identità di un autore risolta dalla users query: email + avatar Slack. */
export interface AuthorInfo {
  email: string;
  avatarUrl: string | null;
}

interface ActivityFeedProps {
  ticketId: string;
  /** authorId/actorId → identità (email + avatar), per firmare commenti utente ed eventi. */
  authors: Map<string, AuthorInfo>;
  /** milestoneId → nome, per rendere leggibili gli eventi milestone_changed. */
  milestoneNames: Map<string, string>;
  /**
   * Invio di un commento: dal campo in cima senza `replyToCommentId`, da
   * quello di una risposta con l'id del commento a cui risponde. Il rigetto
   * lascia nel campo il testo (e la risposta aperta).
   */
  onSubmit: (body: string, replyToCommentId?: string) => Promise<unknown>;
  /** Chi guarda: le sue risposte si leggono «La tua risposta». */
  viewerId?: string | null;
  pending: boolean;
  /**
   * Modifica e cancellazione di un commento (0084). I link compaiono SOLO se
   * il server dà `canEdit`/`canDelete` a chi guarda (letti con `?? false`):
   * il web non deduce il permesso dal ruolo. Il rigetto lascia l'editor
   * aperto col testo, e l'errore sotto.
   */
  onEdit?: (commentId: string, body: string) => Promise<unknown>;
  onDelete?: (commentId: string) => Promise<unknown>;
}

/**
 * Timeline unificata del ticket: commenti (utente/AI/sistema), eventi di audit
 * compatti e marker dei job AI, **dal più recente**, col campo per scrivere un
 * commento nuovo IN CIMA (6 ott 2026, allineamento all'app: il server manda
 * il feed dal più vecchio, qui si rovescia). Il dettaglio tecnico dei job
 * (log/consumi/azioni) resta nel pannello "AI jobs" dedicato
 * (`AIJobTimeline`): qui il job compare solo come riga di stato con link alla
 * PR, per dare la storia senza duplicare le funzionalità.
 *
 * **Risposte (0083) — le stesse regole dell'app** (`CommentsSection.tsx`):
 * «Reply» su ogni commento, anche dell'AI o di sistema, apre il campo SOTTO
 * quel commento, al posto dei bottoni, col fuoco già dentro — niente banner
 * sopra il campo principale, niente salto in fondo. Risposta e modifica sono
 * UNO stato solo (`open`): aprirne una chiude l'altra. Sotto ogni commento,
 * anche eliminato, le card delle risposte ricevute (dalla più recente), che
 * portano alla risposta nel feed. Sopra una risposta «In reply to {nome}:
 * “estratto”», un link a `#comment-<id>` SOLO se l'originale è nel feed.
 * Bozza ed errore si azzerano solo a invio riuscito. `replyTo` si legge con
 * `?? null`: questo client fa un cast, e un server più vecchio della 0083 non
 * lo manda.
 */
export function ActivityFeed({
  ticketId,
  authors,
  milestoneNames,
  viewerId = null,
  onSubmit,
  pending,
  onEdit,
  onDelete,
}: ActivityFeedProps) {
  const { t } = useTranslation();
  const { data: items } = useSuspenseQuery(activityQueryOptions(ticketId));
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenComposer>(null);
  const ordered = newestFirst(items);
  const comments = ordered.filter((item): item is ActivityComment => item.kind === "comment");
  const commentIds = new Set(comments.map((comment) => comment.id));
  // Le risposte ricevute da ogni commento, dalla più recente (`ordered` lo è già).
  const repliesOf = new Map<string, ActivityComment[]>();
  for (const comment of comments) {
    const target = (comment.replyTo ?? null)?.id;
    if (target === undefined) continue;
    repliesOf.set(target, [...(repliesOf.get(target) ?? []), comment]);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || pending) return;
    setError(null);
    try {
      await onSubmit(body);
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("tickets:comments.submitFailed"));
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={(event) => void handleSubmit(event)} className="space-y-2">
        <label
          htmlFor="comment-body"
          className="block font-mono text-[11px] tracking-[0.14em] text-fg-muted uppercase"
        >
          {t("tickets:comments.addComment")}
        </label>
        <MarkdownEditor
          id="comment-body"
          value={draft}
          onChange={setDraft}
          rows={3}
          placeholder={t("tickets:comments.placeholder")}
        />
        <FormError message={error} />
        <button
          type="submit"
          disabled={pending || draft.trim() === ""}
          className="rounded-sm bg-signal px-3 py-1.5 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
        >
          {pending ? t("tickets:comments.submitPending") : t("tickets:comments.submit")}
        </button>
      </form>

      {ordered.length === 0 ? (
        <p className="font-mono text-[12px] text-fg-faint">{t("tickets:activity.empty")}</p>
      ) : (
        <ol className="space-y-3">
          {ordered.map((item) =>
            item.kind === "comment" ? (
              <CommentItem
                key={`${item.kind}-${item.id}`}
                comment={item}
                authors={authors}
                viewerId={viewerId}
                commentIds={commentIds}
                replies={repliesOf.get(item.id) ?? []}
                replying={open?.mode === "reply" && open.commentId === item.id}
                editing={open?.mode === "edit" && open.commentId === item.id}
                onStartReply={() => setOpen({ mode: "reply", commentId: item.id })}
                onStartEdit={() => setOpen({ mode: "edit", commentId: item.id })}
                onClose={() => setOpen(null)}
                onSubmitReply={(body) => onSubmit(body, item.id)}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ) : item.kind === "event" ? (
              <EventItem
                key={`${item.kind}-${item.id}`}
                event={item}
                authors={authors}
                milestoneNames={milestoneNames}
              />
            ) : (
              <AiJobItem key={`${item.kind}-${item.id}`} job={item} />
            ),
          )}
        </ol>
      )}
    </div>
  );
}

/** Il campo aperto sotto un commento: una risposta o una modifica, mai entrambe. */
type OpenComposer = { mode: "reply" | "edit"; commentId: string } | null;

/** Dal più recente; a parità di data resta l'ordine del server, rovesciato (come l'app). */
function newestFirst<T extends { createdAt: string }>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const diff = Date.parse(b.item.createdAt) - Date.parse(a.item.createdAt);
      return diff !== 0 && !Number.isNaN(diff) ? diff : b.index - a.index;
    })
    .map(({ item }) => item);
}

/**
 * Commento: stessa resa del vecchio comment-thread (utente/AI/sistema). In
 * fondo, le card delle risposte ricevute e poi le azioni a DESTRA — o, al
 * loro posto, il campo della risposta o della modifica.
 */
function CommentItem({
  comment,
  authors,
  viewerId,
  commentIds,
  replies,
  replying,
  editing,
  onStartReply,
  onStartEdit,
  onClose,
  onSubmitReply,
  onEdit,
  onDelete,
}: {
  comment: ActivityComment;
  authors: Map<string, AuthorInfo>;
  viewerId: string | null;
  commentIds: Set<string>;
  replies: ActivityComment[];
  replying: boolean;
  editing: boolean;
  onStartReply: () => void;
  onStartEdit: () => void;
  onClose: () => void;
  onSubmitReply: (body: string) => Promise<unknown>;
  onEdit?: (commentId: string, body: string) => Promise<unknown>;
  onDelete?: (commentId: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  // Identità dell'autore umano (email + avatar): null per AI/sistema o autore
  // rimosso, che hanno un trattamento dedicato (badge, niente avatar).
  const author = comment.authorId ? authors.get(comment.authorId) : undefined;
  // ⚠️ `?? null` nel PUNTO DI LETTURA, non solo nel tipo: il client fa un
  // cast, e un server più vecchio della 0083 manda il commento SENZA il campo.
  const replyTo = comment.replyTo ?? null;
  // 0084 — stessa regola: campi assenti = mai modificato, mai eliminato, e
  // nessun permesso. Il permesso è del server, per chi guarda.
  const deletedAt = comment.deletedAt ?? null;
  const editedAt = comment.editedAt ?? null;
  const canEdit = (comment.canEdit ?? false) && onEdit !== undefined;
  const canDelete = (comment.canDelete ?? false) && onDelete !== undefined;
  const name = commentAuthorName(comment, authors, t);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  /**
   * Il fuoco torna su «Edit» SOLO se l'editor si è chiuso con Save o Cancel:
   * se si chiude perché si è aperta una risposta altrove, il fuoco è là.
   */
  const returnFocus = useRef(false);

  // Aperto l'editor, il fuoco ci va (si scrive subito); chiuso con Save o
  // Cancel, torna al bottone da cui si era partiti.
  useEffect(() => {
    if (editing) {
      document.getElementById(`comment-edit-${comment.id}`)?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      editButtonRef.current?.focus();
    }
  }, [editing, comment.id]);

  async function run(action: () => Promise<unknown>, onDone?: () => void) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      onDone?.();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("tickets:comments.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  function closeEditor() {
    returnFocus.current = true;
    onClose();
  }

  const replyCards = replies.map((reply) => (
    <ReplyCard key={reply.id} reply={reply} authors={authors} viewerId={viewerId} />
  ));

  if (deletedAt !== null) {
    // Il SEGNAPOSTO: chi, quando, niente testo (non esiste più), né «Rispondi»
    // né azioni. L'id resta: le risposte ci puntano, e le loro card restano.
    return (
      <li id={`comment-${comment.id}`} className="rounded-sm border border-line bg-ink-900 px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-[12px] text-fg-faint italic">
            {t("tickets:comments.deleted", {
              name: comment.deletedBy?.name ?? t("tickets:comments.removedUser"),
            })}
          </span>
          <time dateTime={deletedAt} title={formatDateTime(deletedAt)} className="font-mono text-[11px] text-fg-faint">
            {formatRelativeTime(deletedAt)}
          </time>
        </div>
        {replyCards}
        <FormError message={actionError} />
      </li>
    );
  }

  return (
    <li
      id={`comment-${comment.id}`}
      className={`rounded-sm border bg-ink-900 px-4 py-3 ${
        comment.authorType === "ai"
          ? "border-signal-dim/40 shadow-[inset_2px_0_0_0_var(--color-signal)]"
          : comment.authorType === "system"
            ? "border-line shadow-[inset_2px_0_0_0_var(--color-line-strong)]"
            : "border-line"
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {comment.authorType === "ai" ? (
          <>
            <span className="rounded-sm bg-signal px-1.5 py-px font-mono text-[10px] font-semibold tracking-[0.12em] text-ink-950 uppercase">
              AI
            </span>
            <span className="font-mono text-[12px] text-fg-muted">Stubwise</span>
          </>
        ) : comment.authorType === "system" ? (
          <span className="rounded-sm border border-line-strong px-1.5 py-px font-mono text-[10px] font-semibold tracking-[0.12em] text-fg-muted uppercase">
            {t("tickets:comments.system")}
          </span>
        ) : author ? (
          <span className="flex items-center gap-2 font-mono text-[12px] text-fg-muted">
            <Avatar src={author.avatarUrl} label={author.email} size={20} />
            {author.email}
          </span>
        ) : (
          <span className="font-mono text-[12px] text-fg-muted">
            {t("tickets:comments.removedUser")}
          </span>
        )}
        <time
          dateTime={comment.createdAt}
          title={formatDateTime(comment.createdAt)}
          className="font-mono text-[11px] text-fg-faint"
        >
          {formatRelativeTime(comment.createdAt)}
        </time>
        {editedAt !== null && (
          <>
            <span
              aria-hidden
              title={t("tickets:comments.editedTitle", { when: formatDateTime(editedAt) })}
              className="font-mono text-[11px] text-fg-faint"
            >
              {t("tickets:comments.edited")}
            </span>
            {/* Il `title` non lo legge lo screen reader: l'ora va anche in testo. */}
            <span className="sr-only">
              {t("tickets:comments.editedA11y", { when: formatDateTime(editedAt) })}
            </span>
          </>
        )}
      </div>
      {replyTo !== null && (
        <p className="mt-1 truncate font-mono text-[11px] text-fg-faint">
          {commentIds.has(replyTo.id) ? (
            <a href={`#comment-${replyTo.id}`} className="transition-colors hover:text-fg">
              {inReplyToText(replyTo, t)}
            </a>
          ) : (
            <span>{inReplyToText(replyTo, t)}</span>
          )}
        </p>
      )}
      {editing ? (
        <form
          className="mt-2 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            const body = draft.trim();
            if (body === "" || busy) return;
            void run(() => onEdit!(comment.id, body), closeEditor);
          }}
        >
          <MarkdownEditor
            id={`comment-edit-${comment.id}`}
            aria-label={t("tickets:comments.editLabel")}
            value={draft}
            onChange={setDraft}
            rows={3}
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setActionError(null);
                closeEditor();
              }}
              className="rounded-sm border border-line-strong px-2.5 py-1 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:text-fg disabled:opacity-50"
            >
              {t("tickets:comments.cancelEdit")}
            </button>
            <button
              type="submit"
              disabled={busy || draft.trim() === ""}
              className="rounded-sm bg-signal px-3 py-1.5 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? t("tickets:comments.savePending") : t("tickets:comments.save")}
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-2">
          <Markdown source={comment.body} />
        </div>
      )}
      {replyCards}
      {/* In fondo, dopo aver letto: le azioni a DESTRA, o al loro posto il
          campo della risposta (la modifica è già al posto del corpo). */}
      {replying ? (
        <ReplyComposer commentId={comment.id} name={name} onSubmit={onSubmitReply} onClose={onClose} />
      ) : (
        !editing && (
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={onStartReply}
              aria-label={t("tickets:comments.replyTo", { name })}
              className={`${actionButtonClass} border-signal/40 text-signal hover:border-signal hover:text-signal-bright`}
            >
              <Glyph name="reply" />
              {t("tickets:comments.reply")}
            </button>
            {canEdit && (
              <button
                ref={editButtonRef}
                type="button"
                aria-label={t("tickets:comments.editA11y", { name })}
                onClick={() => {
                  setDraft(comment.body);
                  setActionError(null);
                  onStartEdit();
                }}
                className={`${actionButtonClass} border-line-strong text-fg-muted hover:border-ink-700 hover:text-fg`}
              >
                <Glyph name="edit" />
                {t("tickets:comments.edit")}
              </button>
            )}
            {canDelete && (
              <ConfirmDeleteButton
                icon={<Glyph name="delete" />}
                label={t("tickets:comments.delete")}
                labelAria={t("tickets:comments.deleteA11y", { name })}
                confirmLabel={t("tickets:comments.confirmDelete")}
                confirmAria={t("tickets:comments.confirmDeleteAria")}
                pending={busy}
                // L1: il registro decisioni non si riscrive — lo dice il server.
                note={(comment.inDecisionLog ?? false) ? t("tickets:comments.decisionLogNote") : undefined}
                onConfirm={() => void run(() => onDelete!(comment.id))}
              />
            )}
          </div>
        )
      )}
      <FormError message={actionError} />
    </li>
  );
}

const actionButtonClass =
  "inline-flex items-center gap-1 rounded-sm border bg-ink-950/70 px-2.5 py-1 font-mono text-[11px] tracking-[0.08em] uppercase transition-colors";

/**
 * Glifi Material Symbols Outlined (24px, viewBox `0 -960 960 960`), gli STESSI
 * dell'app (`apps/mobile/src/components/Icon.tsx`). Colore dal testo.
 */
const GLYPH_PATHS = {
  reply:
    "M760-200v-160q0-50-35-85t-85-35H273l144 144-57 56-240-240 240-240 57 56-144 144h367q83 0 141.5 58.5T840-360v160h-80Z",
  edit: "M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z",
  delete:
    "M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z",
} as const;

function Glyph({ name }: { name: keyof typeof GLYPH_PATHS }) {
  return (
    <svg
      aria-hidden
      data-icon={name}
      viewBox="0 -960 960 960"
      width={14}
      height={14}
      fill="currentColor"
      className="shrink-0"
    >
      <path d={GLYPH_PATHS[name]} />
    </svg>
  );
}

/**
 * Il campo della risposta, SOTTO il commento a cui si risponde, col fuoco già
 * dentro. Bozza ed errore restano finché l'invio non riesce; riuscito, si
 * chiude. È montato solo mentre si risponde: la bozza vive con lui.
 */
function ReplyComposer({
  commentId,
  name,
  onSubmit,
  onClose,
}: {
  commentId: string;
  name: string;
  onSubmit: (body: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = `comment-reply-${commentId}`;

  useEffect(() => {
    document.getElementById(inputId)?.focus();
  }, [inputId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (body === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("tickets:comments.submitFailed"));
      setBusy(false);
    }
  }

  return (
    <form className="mt-3 space-y-2" onSubmit={(event) => void submit(event)}>
      <MarkdownEditor
        id={inputId}
        aria-label={t("tickets:comments.replyInput", { name })}
        value={draft}
        onChange={setDraft}
        rows={3}
        placeholder={t("tickets:comments.replyInput", { name })}
      />
      <FormError message={error} />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          aria-label={t("tickets:comments.cancelReply")}
          className="rounded-sm border border-line-strong px-2.5 py-1 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:text-fg disabled:opacity-50"
        >
          {t("common:cancel")}
        </button>
        <button
          type="submit"
          disabled={busy || draft.trim() === ""}
          className="inline-flex items-center gap-1 rounded-sm bg-signal px-3 py-1.5 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? t("tickets:comments.submitPending") : t("tickets:comments.reply")}
        </button>
      </div>
    </form>
  );
}

/** Lunghezza dell'anteprima di una risposta sotto l'originale (come l'app). */
const REPLY_PREVIEW_CHARS = 120;

/**
 * Una risposta ricevuta, sotto il commento a cui risponde: chi, quando e due
 * righe d'anteprima. Cliccata, scorre alla risposta nel feed.
 */
function ReplyCard({
  reply,
  authors,
  viewerId,
}: {
  reply: ActivityComment;
  authors: Map<string, AuthorInfo>;
  viewerId: string | null;
}) {
  const { t } = useTranslation();
  const who =
    viewerId !== null && reply.authorId === viewerId
      ? t("tickets:comments.yourReply")
      : t("tickets:comments.replyFrom", { name: commentAuthorName(reply, authors, t) });
  const deleted = (reply.deletedAt ?? null) !== null;
  return (
    <button
      type="button"
      title={t("tickets:comments.goToReply")}
      onClick={() =>
        document.getElementById(`comment-${reply.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
      }
      className="mt-2 block w-full rounded-sm border border-line bg-ink-950/60 px-3 py-2 text-left transition-colors hover:border-line-strong"
    >
      <span className="block font-mono text-[11px] text-fg-muted">
        ↳ {who} · {formatRelativeTime(reply.createdAt)}
      </span>
      <span className={`mt-0.5 line-clamp-2 text-[13px] ${deleted ? "text-fg-faint italic" : "text-fg"}`}>
        {deleted ? t("tickets:comments.deletedShort") : plainExcerpt(reply.body, REPLY_PREVIEW_CHARS)}
      </span>
    </button>
  );
}

/** Il nome di chi ha scritto un commento del feed, come lo firma la riga. */
function commentAuthorName(comment: ActivityComment, authors: Map<string, AuthorInfo>, t: TFunc): string {
  if (comment.authorType === "ai") return t("tickets:comments.aiName");
  if (comment.authorType === "system") return t("tickets:comments.systemName");
  if (comment.authorId === null) return t("tickets:comments.removedUser");
  return authors.get(comment.authorId)?.email ?? t("tickets:comments.removedUser");
}

/**
 * «In reply to {nome}: “estratto”», dal `replyTo` che il server deriva. Un
 * `authorType` che questo client non conosce è «someone», mai una stringa
 * grezza; una persona senza nome (eliminata) è «utente rimosso».
 */
function inReplyToText(replyTo: CommentReplyTo, t: TFunc): string {
  const name =
    replyTo.authorType === "ai"
      ? t("tickets:comments.aiName")
      : replyTo.authorType === "system"
        ? t("tickets:comments.systemName")
        : replyTo.authorType === "user"
          ? (replyTo.authorName ?? t("tickets:comments.removedUser"))
          : t("tickets:comments.someone");
  // 0084: `?? false`, un server più vecchio non lo manda.
  if (replyTo.deleted ?? false) return t("tickets:comments.inReplyToDeleted");
  return t("tickets:comments.inReplyTo", { name, excerpt: replyTo.excerpt });
}

/** Riga di audit compatta: testo i18n con interpolazione + timestamp. */
function EventItem({
  event,
  authors,
  milestoneNames,
}: {
  event: ActivityEvent;
  authors: Map<string, AuthorInfo>;
  milestoneNames: Map<string, string>;
}) {
  const { t } = useTranslation();
  const text = describeEvent(event, authors, milestoneNames, t);
  if (!text) return null;
  // Avatar dell'attore umano accanto alla riga; assente per attore di sistema
  // (actorId null) o utente rimosso, coerente col fallback testuale.
  const actor = event.actorId ? authors.get(event.actorId) : undefined;
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 font-mono text-[11px] text-fg-faint">
      {actor ? (
        <Avatar src={actor.avatarUrl} label={actor.email} size={16} />
      ) : (
        <span aria-hidden className="text-line-strong">
          ·
        </span>
      )}
      <span className="text-fg-muted">{text}</span>
      <time
        dateTime={event.createdAt}
        title={formatDateTime(event.createdAt)}
        className="text-fg-faint"
      >
        {formatRelativeTime(event.createdAt)}
      </time>
    </li>
  );
}

type TFunc = ReturnType<typeof useTranslation>["t"];

/** Nome leggibile dell'attore: email risolta, "System" se assente. */
function actorName(actorId: string | null, authors: Map<string, AuthorInfo>, t: TFunc): string {
  if (actorId === null) return t("tickets:activity.systemActor");
  return authors.get(actorId)?.email ?? t("tickets:comments.removedUser");
}

/** Estrae from/to grezzi dal payload jsonb (string|null). */
function fromTo(payload: Record<string, unknown> | null): {
  from: unknown;
  to: unknown;
} {
  return { from: payload?.from ?? null, to: payload?.to ?? null };
}

/** Compone il messaggio di audit di un evento mappando gli enum alle label. */
function describeEvent(
  event: ActivityEvent,
  authors: Map<string, AuthorInfo>,
  milestoneNames: Map<string, string>,
  t: TFunc,
): string {
  const actor = actorName(event.actorId, authors, t);
  const { from, to } = fromTo(event.payload);

  switch (event.eventKind) {
    case "status_changed":
      return t("tickets:activity.events.status_changed", {
        actor,
        from: statusLabel(from, t),
        to: statusLabel(to, t),
      });
    case "priority_changed":
      return t("tickets:activity.events.priority_changed", {
        actor,
        from: priorityLabel(from, t),
        to: priorityLabel(to, t),
      });
    case "type_changed":
      return t("tickets:activity.events.type_changed", {
        actor,
        from: typeLabel(from, t),
        to: typeLabel(to, t),
      });
    case "assignee_changed":
      return to === null || to === undefined
        ? t("tickets:activity.events.unassigned", { actor })
        : t("tickets:activity.events.assignee_changed", {
            actor,
            user: userLabel(to, authors, t),
          });
    case "labels_changed":
      return t("tickets:activity.events.labels_changed", { actor });
    case "title_changed":
      return t("tickets:activity.events.title_changed", { actor });
    case "body_changed":
      return t("tickets:activity.events.body_changed", { actor });
    // milestone_changed: from/to sono id (o null). Si risolve l'id al nome
    // (fallback "—" se la milestone è stata cancellata) e si sceglie la
    // variante: set (null→x), removed (x→null), changed (x→y).
    case "milestone_changed": {
      const hasFrom = typeof from === "string";
      const hasTo = typeof to === "string";
      const fromName = milestoneLabel(from, milestoneNames, t);
      const toName = milestoneLabel(to, milestoneNames, t);
      if (!hasFrom && hasTo)
        return t("tickets:activity.events.milestone_changed.set", { actor, to: toName });
      if (hasFrom && !hasTo)
        return t("tickets:activity.events.milestone_changed.removed", { actor, from: fromName });
      return t("tickets:activity.events.milestone_changed.changed", {
        actor,
        from: fromName,
        to: toName,
      });
    }
    // L'evento relazione porta nel payload la kind canonica (blocks/relates_to/
    // parent) e la direzione (outgoing/incoming) dal punto di vista del ticket
    // corrente. Si mappa kind+direzione alla relazione MOSTRATA (la stessa scala
    // a 5 valori di TicketRelation) e si compone il testo col numero dell'altro.
    case "relation_added":
    case "relation_removed":
      return t(`tickets:activity.events.${event.eventKind}.${relationFromPayload(event.payload)}`, {
        actor,
        number: relationNumber(event.payload),
      });
  }
}

/** Relazioni canoniche (kind) → relazione mostrata, per direzione. */
const RELATION_BY_DIRECTION: Record<string, Record<string, string>> = {
  outgoing: { blocks: "blocks", relates_to: "relates_to", parent: "parent" },
  incoming: { blocks: "blocked_by", relates_to: "relates_to", parent: "child" },
};

/**
 * Dal payload dell'evento relazione (`{ kind, direction, otherNumber }`)
 * ricava la relazione da mostrare: outgoing usa la kind, incoming la inverte
 * (blocks→blocked_by, parent→child, relates_to resta simmetrica).
 */
function relationFromPayload(payload: Record<string, unknown> | null): string {
  const kind = typeof payload?.kind === "string" ? payload.kind : "relates_to";
  const direction = payload?.direction === "incoming" ? "incoming" : "outgoing";
  return RELATION_BY_DIRECTION[direction]?.[kind] ?? "relates_to";
}

function relationNumber(payload: Record<string, unknown> | null): number | string {
  const n = payload?.otherNumber;
  return typeof n === "number" ? n : "?";
}

function statusLabel(raw: unknown, t: TFunc): string {
  const key = STATUS_LABEL_KEYS[raw as keyof typeof STATUS_LABEL_KEYS];
  return key ? t(key) : String(raw);
}

function priorityLabel(raw: unknown, t: TFunc): string {
  const key = PRIORITY_LABEL_KEYS[raw as keyof typeof PRIORITY_LABEL_KEYS];
  return key ? t(key) : String(raw);
}

function typeLabel(raw: unknown, t: TFunc): string {
  const key = TYPE_LABEL_KEYS[raw as keyof typeof TYPE_LABEL_KEYS];
  return key ? t(key) : String(raw);
}

function userLabel(raw: unknown, authors: Map<string, AuthorInfo>, t: TFunc): string {
  if (typeof raw !== "string") return String(raw);
  return authors.get(raw)?.email ?? t("tickets:comments.removedUser");
}

/** Nome di una milestone dall'id; "—" se cancellata (id non risolvibile). */
function milestoneLabel(raw: unknown, milestoneNames: Map<string, string>, t: TFunc): string {
  if (typeof raw !== "string") return "—";
  return milestoneNames.get(raw) ?? t("milestones:none");
}

/** Marker compatto di un job AI: etichetta di stato + eventuale link PR. */
function AiJobItem({ job }: { job: ActivityAiJob }) {
  const { t } = useTranslation();
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1 font-mono text-[11px]">
      <span aria-hidden className="text-line-strong">
        ·
      </span>
      <span className={`tracking-[0.08em] uppercase ${WORK_STATE_TEXT_CLASS[workStateFor(job.status)]}`}>
        {t(WORK_STATE_LABEL_KEYS[workStateFor(job.status)])}
      </span>
      <time
        dateTime={job.createdAt}
        title={formatDateTime(job.createdAt)}
        className="text-fg-faint"
      >
        {formatRelativeTime(job.createdAt)}
      </time>
      {job.prUrl && (
        <a
          href={job.prUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded-sm border border-ok/40 px-1.5 py-px tracking-[0.08em] text-ok uppercase transition-colors hover:border-ok hover:bg-ok/10"
        >
          {t("tickets:timeline.viewPr")}
        </a>
      )}
    </li>
  );
}
