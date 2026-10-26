import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  MAIL_LIMITS,
  useDiscardMailDraft,
  useMailboxes,
  usePeople,
  useProjects,
  useSendMailDraft,
} from "../../data/queries";
import type {
  DriveFileRow,
  MailAddress,
  MailDraft,
  MailDraftAttachment,
  MailMessageView,
  MailSendResult,
  Project,
} from "../../data/types";
import { hasModKey, shortcutLabel } from "../../platform/platform";
import { Menu, MenuGroup, RadioItem, itemClass } from "../../tasks-ui/Menu";
import {
  PaperclipGlyph,
  primaryButton,
  quietButton,
  secondaryButton,
} from "../claude/conversation/parts";
import { openGoogleAccount } from "../drive/GoogleAccountCard";
import { MenuButton } from "../tasks/controls";
import { Chevron } from "../../tasks-ui/Menu";
import {
  ClaudeDraftButton,
  ClaudeDraftNote,
  ClaudeHintRow,
  useClaudeDraft,
} from "./ClaudeDraftButton";
import {
  AttachmentToken,
  DriveAttachDialog,
  driveAttachment,
  overLimit,
} from "./ComposeAttachments";
import { AlertGlyph } from "./glyphs";
import { ADDRESS, RecipientField } from "./RecipientField";
import { useComposerDraft } from "./useComposerDraft";

// La casella di scrittura della Posta (shape mail-compose §3, §5, §6): la
// stessa casella della conversazione con Claude, allargata a un modulo —
// bordo `rule-strong`, 8 px, nessuna ombra — con le righe A, Cc, Oggetto
// separate da filetti, il corpo in testo semplice, il testo citato, gli
// allegati e la barra (Attach, Ask Claude · stato della bozza, Discard,
// Send). In fondo alla conversazione per Rispondi / Rispondi a tutti /
// Inoltra; a tutta altezza nel pannello per la nuova email.
//
// - Una bozza per conversazione [A 1]: si salva da sé 800 ms dopo l'ultima
//   modifica, chiudendo, cambiando conversazione e PRIMA di cambiare
//   persona (a nome di chi scriveva: dopo il cambio non salva più nulla).
//   Aprire senza scrivere non crea una bozza.
// - Nulla parte senza «Send» (o ⌘Enter): né la bozza di Claude, né una
//   bozza salvata. Mentre Claude scrive, «Send» è spento.
// - Controlli in linea, mai dialoghi: nessun destinatario, un indirizzo non
//   valido, oltre 10 file o 25 MB, la casella scaduta spengono «Send» con la
//   ragione nel `title`; l'oggetto vuoto chiede al primo «Send».

type Mode = MailDraft["mode"];

let uploads = 0;

/** La ragione di un invio rifiutato, in parole. */
function reasonKey(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "google_not_connected") return "mail.compose.reason.notConnected";
  if (message === "attachment_unavailable") return "mail.compose.reason.attachment";
  if (message === "invalid: too_large" || message === "invalid: attachments")
    return "mail.compose.reason.tooLarge";
  if (message === "invalid: address") return "mail.compose.reason.address";
  if (message === "invalid: recipients") return "mail.compose.reason.recipients";
  return "mail.compose.reason.other";
}

export interface ComposerProps {
  threadId: string | null;
  mode: Mode;
  /** Passare a un'altra modalità dal menu in testa (il corpo resta). */
  onModeChange?: (mode: Mode) => void;
  /** Il messaggio a cui si risponde, per il testo citato. */
  messages?: readonly MailMessageView[];
  /** I progetti della conversazione (Drive e «About»). */
  threadProjects: readonly Project[];
  /** Dove va il fuoco all'apertura: il corpo, il primo campo della modalità, o nessuno. */
  focus: "body" | "start" | "none";
  /** A tutta altezza nel pannello (nuova email), con «Discard» · «Close» in testa. */
  full?: boolean;
  /** Chiusa (Esc, «Close», «← Back»): la bozza è già salvata. */
  onClose: () => void;
  /** «Discard»: la bozza è tolta; `snapshot` per l'«Undo» dell'avviso. */
  onDiscarded: (snapshot: MailDraft) => void;
  onSent: (result: MailSendResult, recipients: MailAddress[]) => void;
  /** Sopra la casella (finestra stretta: «← Back to the conversation»). */
  header?: ReactNode;
}

export function Composer(props: ComposerProps) {
  const {
    threadId,
    mode,
    onModeChange,
    messages,
    threadProjects,
    focus,
    full,
    onClose,
    onDiscarded,
    onSent,
  } = props;
  const { t } = useTranslation();
  const send = useSendMailDraft();
  const discard = useDiscardMailDraft();
  const peopleList = usePeople().data;
  const people = new Map((peopleList ?? []).map((p) => [p.id, p]));
  const allProjects = useProjects().data ?? [];
  const box = useMailboxes().data?.[0];

  const [ccOpen, setCcOpen] = useState(false);
  const [quotedOpen, setQuotedOpen] = useState(false);
  const [askSubject, setAskSubject] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [attachMenu, setAttachMenu] = useState(false);
  const [drivePicker, setDrivePicker] = useState(false);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const rootRef = useRef<HTMLFormElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const ccRef = useRef<HTMLInputElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const hintRef = useRef<HTMLInputElement>(null);
  const attachButton = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const formId = useId();

  const draft = useComposerDraft({
    threadId,
    mode,
    onClose,
    onLoaded: (f) => setCcOpen(f.cc.length > 0),
    onEdit: () => setSendError(null),
  });
  const { fields, loadFailed, status, setFields, owner } = draft;

  // Il fuoco all'apertura, a bozza letta (solo all'apertura).
  const loaded = fields !== null;
  useLayoutEffect(() => {
    if (!loaded || focus === "none") return;
    const target =
      focus === "start" && (mode === "forward" || mode === "new") ? toRef.current : bodyRef.current;
    target?.focus();
    rootRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [loaded]);

  const claude = useClaudeDraft({
    threadId,
    body: fields?.body ?? "",
    setBody: (text) => setFields({ body: text }),
    hintRef,
  });

  // Mentre Claude scrive il fuoco resta nella casella (sul corpo in sola
  // lettura): ⌘. ferma, Esc chiude. Finita o fermata (con ⌘. o col clic su
  // Stop), corpo in sola lettura e Stop non ci sono più e il fuoco cadrebbe
  // sul documento: torna nel corpo modificabile — salvo che chi scrive
  // l'abbia portato in un altro campo della casella nel frattempo.
  const streamRef = useRef<HTMLDivElement>(null);
  const wasWriting = useRef(false);
  const writingNow = claude.writing;
  useLayoutEffect(() => {
    const active = document.activeElement;
    const outside = !active || active === document.body || !rootRef.current?.contains(active);
    if (writingNow) {
      wasWriting.current = true;
      if (outside || active === bodyRef.current) streamRef.current?.focus();
      return;
    }
    if (!wasWriting.current) return;
    wasWriting.current = false;
    if (outside) bodyRef.current?.focus();
  }, [writingNow]);

  // Il corpo cresce con il testo fino a riempire il pannello, poi scorre dentro.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [fields?.body, claude.writing]);

  if (loadFailed) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-rule-strong px-3 py-3 text-sm text-critical">
        <AlertGlyph size={14} />
        {t("mail.compose.loadFailed")}
        <button type="button" className={quietButton} onClick={onClose}>
          {t("mail.compose.close")}
        </button>
      </div>
    );
  }
  if (!fields) {
    return <div aria-busy="true" className="h-40 rounded-lg border border-rule-strong" />;
  }

  // --- invio -------------------------------------------------------------------
  const recipients = [...fields.to, ...fields.cc];
  const invalid = recipients.some((a) => !ADDRESS.test(a.email.trim()));
  const over = overLimit(fields.attachments, MAIL_LIMITS.bytes);
  const expired = !!box?.expired;
  // Mentre Claude scrive «Send» è spento senza altra ragione: il corpo non è ancora suo.
  const blocked = claude.writing
    ? ""
    : recipients.length === 0
      ? t("mail.compose.noRecipients")
      : invalid
        ? t("mail.compose.invalid")
        : fields.attachments.length > MAIL_LIMITS.attachments
          ? t("mail.compose.tooMany")
          : over.size > 0
            ? t("mail.compose.tooLarge")
            : expired
              ? t("mail.compose.expired", { email: box?.email ?? "" })
              : null;
  const canSend = blocked === null && !sending;

  async function doSend(force = false) {
    const f = draft.current();
    if (!canSend || !f) return;
    if (!force && !f.subject.trim()) {
      setAskSubject(true);
      return;
    }
    setAskSubject(false);
    setSending(true);
    try {
      const saved = await draft.saveForSend();
      const result = await send.mutateAsync(saved.id);
      draft.markSent();
      onSent(result, [...f.to, ...f.cc]);
    } catch (error) {
      setSendError(t("mail.compose.couldntSend", { reason: t(reasonKey(error)) }));
      setSending(false);
    }
  }

  function close() {
    void draft.closeNow();
  }

  function doDiscard() {
    const snapshot = draft.discarded();
    discard.mutate(snapshot.id);
    onDiscarded(snapshot);
  }

  // --- allegati ----------------------------------------------------------------
  function addAttachments(more: MailDraftAttachment[]) {
    const current = draft.current()!.attachments;
    const fresh = more.filter((a) => !current.some((x) => x.id === a.id));
    const room = MAIL_LIMITS.attachments - current.length;
    setAttachNote(fresh.length > room ? t("mail.compose.tooMany") : null);
    if (room <= 0 || fresh.length === 0) return;
    setFields({ attachments: [...current, ...fresh.slice(0, room)] });
  }
  function addFiles(files: File[]) {
    addAttachments(
      files.map((file) => ({
        id: `up-${owner}-${++uploads}`,
        name: file.name,
        sizeBytes: file.size,
        driveFileId: null,
        as: "copy" as const,
      })),
    );
  }
  const driveProjects = threadProjects.length > 0 ? threadProjects : allProjects;
  const driveProject = threadProjects.length === 1 ? threadProjects[0]! : null;

  // --- tastiera -----------------------------------------------------------------
  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    // I tasti di un dialogo aperto da qui (in un portale) sono suoi.
    if (!e.currentTarget.contains(e.target as Node)) return;
    const mod = hasModKey(e);
    const key = e.key.toLowerCase();
    if (mod && !e.shiftKey && key === "enter") {
      e.preventDefault();
      void doSend();
    } else if (mod && !e.shiftKey && key === "j") {
      e.preventDefault();
      claude.openHint();
    } else if (mod && !e.shiftKey && key === ".") {
      e.preventDefault();
      claude.stop();
    } else if (mod && e.shiftKey && key === "c") {
      e.preventDefault();
      setCcOpen((open) => {
        if (!open) requestAnimationFrame(() => ccRef.current?.focus());
        return !open;
      });
    } else if (mod && e.shiftKey && key === "a") {
      e.preventDefault();
      setAttachMenu(true);
    } else if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function onDrop(e: DragEvent<HTMLFormElement>) {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    setDragging(false);
    addFiles([...e.dataTransfer.files]);
  }

  // --- testata ------------------------------------------------------------------
  const firstName = (fields.to[0]?.name || fields.to[0]?.email) ?? "";
  const title =
    mode === "new"
      ? t("mail.compose.newEmail")
      : mode === "forward"
        ? t("mail.compose.forward")
        : mode === "replyAll"
          ? t("mail.compose.replyToAll", { count: recipients.length })
          : firstName
            ? t("mail.compose.replyTo", { name: firstName })
            : t("mail.compose.reply");
  const original = messages?.find((m) => m.id === fields.replyToMessageId);
  const statusText =
    status === "saving"
      ? t("mail.compose.saving")
      : status === "saved"
        ? t("mail.compose.saved")
        : null;

  const ccLink = !ccOpen ? (
    <button
      type="button"
      onClick={() => {
        setCcOpen(true);
        requestAnimationFrame(() => ccRef.current?.focus());
      }}
      title={`Cc (${shortcutLabel(["mod", "shift", "C"])})`}
      className="rounded-sm px-1 text-sm font-medium text-ink-muted underline decoration-ink/30 underline-offset-2 hover:text-ink"
    >
      {t("mail.compose.cc")}
    </button>
  ) : null;

  const form = (
    <form
      ref={rootRef}
      aria-label={title}
      data-composer={threadId ?? "new"}
      onSubmit={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
      onDragEnter={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) setDragging(true);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
      className={`compose-enter relative flex min-w-0 flex-col rounded-lg border border-rule-strong bg-surface ${full ? "min-h-[420px] flex-1" : ""}`}
    >
      {mode !== "new" && onModeChange && (
        <div className="flex h-8 items-center border-b border-rule px-2">
          <MenuButton
            menuLabel={t("mail.compose.modeMenu")}
            ariaLabel={`${t("mail.compose.modeMenu")}: ${title}`}
            className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs font-semibold text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/10"
            label={
              <>
                <span className="truncate">{title}</span>
                <Chevron />
              </>
            }
          >
            {(closeMenu) => (
              <MenuGroup label={t("mail.compose.modeMenu")}>
                {(["reply", "replyAll", "forward"] as const).map((m) => (
                  <RadioItem
                    key={m}
                    checked={mode === m}
                    onSelect={() => (onModeChange(m), closeMenu())}
                  >
                    {t(`mail.compose.${m}`)}
                  </RadioItem>
                ))}
              </MenuGroup>
            )}
          </MenuButton>
        </div>
      )}
      <RecipientField
        label={t("mail.compose.to")}
        value={fields.to}
        onChange={(to) => setFields({ to })}
        people={people}
        inputRef={toRef}
        trailing={ccLink}
      />
      {ccOpen && (
        <RecipientField
          label={t("mail.compose.cc")}
          value={fields.cc}
          onChange={(cc) => setFields({ cc })}
          people={people}
          inputRef={ccRef}
        />
      )}
      <div className="flex h-8 min-w-0 items-center gap-2 border-b border-rule px-3">
        <label htmlFor={`${formId}-subject`} className="w-14 shrink-0 text-sm text-ink-muted">
          {t("mail.compose.subject")}
        </label>
        <input
          ref={subjectRef}
          id={`${formId}-subject`}
          value={fields.subject}
          onChange={(e) => {
            setAskSubject(false);
            setFields({ subject: e.target.value });
          }}
          placeholder={t("mail.compose.subject")}
          className="h-full min-w-0 flex-1 bg-transparent text-md text-ink outline-none placeholder:text-ink-faint"
        />
      </div>
      <div className={`flex min-w-0 flex-col ${full ? "flex-1" : ""}`}>
        {claude.writing ? (
          <div
            ref={streamRef}
            role="textbox"
            tabIndex={0}
            aria-label={t("mail.compose.message")}
            aria-readonly="true"
            aria-busy="true"
            aria-multiline="true"
            className="max-h-[60vh] min-h-[132px] overflow-y-auto px-3 py-2.5 outline-none text-md whitespace-pre-wrap text-ink [overflow-wrap:anywhere]"
          >
            {claude.streamingBody}
            <span
              aria-hidden="true"
              data-stream-cursor
              className="stream-caret ml-0.5 inline-block h-4 w-[2px] translate-y-[3px] rounded-[1px] bg-ink"
            />
          </div>
        ) : (
          <textarea
            ref={bodyRef}
            aria-label={t("mail.compose.message")}
            value={fields.body}
            onChange={(e) => setFields({ body: e.target.value })}
            placeholder={mode === "new" ? t("mail.compose.bodyNew") : t("mail.compose.bodyReply")}
            rows={5}
            className={`max-h-[60vh] min-h-[132px] w-full resize-none bg-transparent px-3 py-2.5 text-md text-ink outline-none placeholder:text-ink-faint ${full ? "flex-1" : ""}`}
          />
        )}
        <ClaudeDraftNote flow={claude} projects={allProjects} />
        {original && mode !== "new" && (
          <div className="flex flex-col gap-2 px-3 pb-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              <button
                type="button"
                aria-expanded={quotedOpen}
                onClick={() => setQuotedOpen((v) => !v)}
                className="rounded-md border border-rule px-2 leading-5 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
              >
                <span aria-hidden="true">··· </span>
                {quotedOpen ? t("mail.compose.hideQuoted") : t("mail.compose.showQuoted")}
              </button>
              {mode !== "forward" &&
                (fields.quote ? (
                  <button
                    type="button"
                    onClick={() => setFields({ quote: false })}
                    className="rounded-sm underline decoration-ink/30 underline-offset-2 hover:text-ink"
                  >
                    {t("mail.compose.removeQuoted")}
                  </button>
                ) : (
                  <span>
                    {t("mail.compose.quoteRemoved")}{" "}
                    <button
                      type="button"
                      onClick={() => setFields({ quote: true })}
                      className="rounded-sm font-medium text-ink underline decoration-ink/30 underline-offset-2"
                    >
                      {t("mail.compose.includeQuoted")}
                    </button>
                  </span>
                ))}
            </div>
            {quotedOpen && (
              <blockquote
                className={`max-h-48 max-w-[68ch] overflow-y-auto border-l border-rule-strong pl-3 text-sm whitespace-pre-line text-ink-muted ${fields.quote || mode === "forward" ? "" : "opacity-50"}`}
              >
                {original.text}
              </blockquote>
            )}
          </div>
        )}
      </div>
      {fields.attachments.length > 0 && (
        <ul aria-label={t("mail.compose.attach")} className="flex flex-wrap gap-1.5 px-3 pb-2">
          {fields.attachments.map((a) => (
            <AttachmentToken
              key={a.id}
              attachment={a}
              over={over.has(a.id)}
              onRemove={() =>
                setFields({
                  attachments: draft.current()!.attachments.filter((x) => x.id !== a.id),
                })
              }
            />
          ))}
        </ul>
      )}
      {(over.size > 0 || attachNote) && (
        <p className="flex items-center gap-1.5 px-3 pb-2 text-xs text-critical">
          <AlertGlyph size={12} />
          {over.size > 0 ? t("mail.compose.tooLarge") : attachNote}
        </p>
      )}
      <ClaudeHintRow flow={claude} hintRef={hintRef} projects={allProjects} />
      {askSubject && (
        <div className="flex flex-wrap items-center gap-2 border-t border-rule px-3 py-2 text-sm text-ink">
          <p className="min-w-0 flex-1">{t("mail.compose.askSubject")}</p>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => {
              setAskSubject(false);
              subjectRef.current?.focus();
            }}
          >
            {t("mail.compose.addSubject")}
          </button>
          <button type="button" className={primaryButton} onClick={() => void doSend(true)}>
            {t("mail.compose.sendAnyway")}
          </button>
        </div>
      )}
      {expired && box && (
        <p className="flex flex-wrap items-center gap-1.5 border-t border-rule px-3 py-2 text-sm text-critical">
          <AlertGlyph size={14} />
          {t("mail.compose.expired", { email: box.email })}
          <button type="button" className={secondaryButton} onClick={() => openGoogleAccount()}>
            {t("mail.compose.reconnect")}
          </button>
        </p>
      )}
      {sendError && (
        <p
          role="alert"
          className="flex items-center gap-1.5 border-t border-rule px-3 py-2 text-sm text-critical"
        >
          <AlertGlyph size={14} />
          {sendError}
        </p>
      )}
      <div className="flex min-h-12 flex-wrap items-center gap-1 border-t border-rule px-2 py-2">
        <span className="relative inline-flex">
          <button
            ref={attachButton}
            type="button"
            aria-haspopup="menu"
            aria-expanded={attachMenu}
            onClick={() => setAttachMenu((o) => !o)}
            title={`${t("mail.compose.attach")} (${shortcutLabel(["mod", "shift", "A"])})`}
            className={`${quietButton} aria-expanded:bg-ink/10`}
          >
            <PaperclipGlyph />
            {t("mail.compose.attach")}
            <Chevron />
          </button>
          {attachMenu && (
            <Menu
              label={t("mail.compose.attach")}
              placement="above"
              onClose={(restore) => {
                setAttachMenu(false);
                if (restore) attachButton.current?.focus();
              }}
            >
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={itemClass}
                onClick={() => {
                  setAttachMenu(false);
                  fileInput.current?.click();
                }}
              >
                {t("mail.compose.upload")}
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={itemClass}
                onClick={() => {
                  setAttachMenu(false);
                  setDrivePicker(true);
                }}
              >
                {driveProject
                  ? t("mail.compose.fromDrive", { code: driveProject.code })
                  : t("mail.compose.fromDriveAny")}
              </button>
            </Menu>
          )}
        </span>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <ClaudeDraftButton flow={claude} />
        <span className="ml-auto flex items-center gap-1">
          {status === "failed" ? (
            <span className="flex items-center gap-1 px-1 text-xs text-critical">
              {t("mail.compose.saveFailed")} ·
              <button
                type="button"
                onClick={draft.retrySave}
                className="rounded-sm font-medium underline underline-offset-2"
              >
                {t("mail.compose.retry")}
              </button>
            </span>
          ) : (
            statusText && (
              <span role="status" className="px-1 text-xs text-ink-faint">
                {statusText}
              </span>
            )
          )}
          <button type="button" className={quietButton} onClick={doDiscard}>
            {t("mail.compose.discard")}
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={!canSend}
            aria-disabled={!canSend}
            title={blocked || `${t("mail.compose.send")} (${shortcutLabel(["mod", "Enter"])})`}
            onClick={() => void doSend()}
          >
            {t("mail.compose.send")}
          </button>
        </span>
      </div>
      {dragging && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-lg border border-dashed border-ink/60 bg-surface/90 text-md font-medium text-ink">
          {t("mail.compose.drop")}
        </div>
      )}
      {drivePicker && (
        <DriveAttachDialog
          projects={driveProjects}
          initialProjectId={driveProject?.id ?? null}
          onClose={() => setDrivePicker(false)}
          onAttach={(files: DriveFileRow[]) => {
            setDrivePicker(false);
            addAttachments(files.map(driveAttachment));
          }}
        />
      )}
    </form>
  );

  if (!full) {
    return (
      <>
        {props.header}
        {form}
      </>
    );
  }
  return (
    <div data-new-email className="flex min-h-0 flex-1 flex-col gap-4">
      <header className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 text-xl leading-[26px] font-semibold text-ink">
          {t("mail.compose.newEmail")}
        </h2>
        <button type="button" className={quietButton} onClick={doDiscard}>
          {t("mail.compose.discard")}
        </button>
        <button type="button" className={secondaryButton} onClick={close}>
          {t("mail.compose.close")}
        </button>
      </header>
      {form}
    </div>
  );
}
