import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { MailAddress, MailMessageView, Person } from "../../data/types";
import { WorkingRing } from "../claude/conversation/parts";
import { SaveToDriveButton } from "../chat/SaveToDrive";
import { formatSize } from "../drive/format";
import { TypeGlyph } from "../drive/glyphs";
import { useToast } from "../../tasks-ui/Toast";
import { MenuButton } from "../tasks/controls";
import { itemClass } from "../../tasks-ui/Menu";
import { relativeDay, whenLabel, whenWithTime } from "./format";
import { AlertGlyph, MoreGlyph, VideoGlyph } from "./glyphs";
import { UntrustedHtmlFrame } from "./UntrustedHtmlFrame";

// Un messaggio della conversazione (shape mail.md §3, §5): espanso — chi,
// a chi, il testo pulito (l'originale HTML a richiesta, A9), il testo
// citato piegato, gli allegati, lo stato dell'analisi e, sotto, le schede
// delle proposte che ne sono nate — o chiuso, una riga di 40 px.

/** Oltre questi destinatari la riga «to …» si comprime in «and N others». */
const RECIPIENTS_INLINE = 3;

function Avatar({ address, people, size }: { address: MailAddress; people: ReadonlyMap<string, Person>; size: 24 | 32 }) {
  const person = address.personId ? people.get(address.personId) : undefined;
  const text = person?.initials ?? (address.name || address.email).charAt(0).toUpperCase();
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={`grid shrink-0 place-items-center rounded-full text-xs font-semibold text-ink ${person ? "bg-ink/10" : "bg-ink/6"}`}
    >
      {text}
    </span>
  );
}

/** Le persone del team prima, per nome; poi gli altri come arrivano. */
const teamFirst = (list: readonly MailAddress[]) =>
  [...list].sort((a, b) =>
    a.personId && b.personId ? a.name.localeCompare(b.name) : a.personId ? -1 : b.personId ? 1 : 0,
  );

const nameOf = (a: MailAddress) => a.name || a.email;

/** «to Giulia Ferri, Marco Bellini · cc Laura Costa», o «… and 38 others» che apre l'elenco. */
function Recipients({ message }: { message: MailMessageView }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const to = teamFirst(message.to);
  const cc = teamFirst(message.cc ?? []);
  const total = to.length + cc.length;
  if (total === 0) return null;
  if (total <= RECIPIENTS_INLINE) {
    return (
      <p className="text-sm text-ink-muted [overflow-wrap:anywhere]">
        {to.length > 0 && `${t("mail.message.to")} ${to.map(nameOf).join(", ")}`}
        {cc.length > 0 && `${to.length > 0 ? " · " : ""}${t("mail.message.cc")} ${cc.map(nameOf).join(", ")}`}
      </p>
    );
  }
  const first = teamFirst([...to, ...cc]).slice(0, 2);
  return (
    <div className="flex flex-col gap-1 text-sm text-ink-muted">
      {!open ? (
        <p className="[overflow-wrap:anywhere]">
          {t("mail.message.to")} {first.map(nameOf).join(", ")}{" "}
          <button
            type="button"
            aria-expanded={false}
            aria-controls={listId}
            onClick={() => setOpen(true)}
            className="rounded-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
          >
            {t("mail.message.andOthers", { count: total - first.length })}
          </button>
        </p>
      ) : (
        <div id={listId} data-recipients className="flex max-h-40 flex-col gap-1.5 overflow-y-auto">
          {([
            ["to", to],
            ["cc", cc],
          ] as const).map(([group, list]) =>
            list.length > 0 ? (
              <p key={group} className="[overflow-wrap:anywhere]">
                <span className="font-medium text-ink">{t(`mail.message.${group}Group`)}</span>{" "}
                {list.map(nameOf).join(", ")}
              </p>
            ) : null,
          )}
          <button
            type="button"
            aria-expanded={true}
            onClick={() => setOpen(false)}
            className="self-start rounded-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
          >
            {t("mail.message.showLess")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Il testo pulito, a paragrafi, ≤ 68ch. */
function Body({ text, muted = false }: { text: string; muted?: boolean }) {
  return (
    <div className={`flex max-w-[68ch] flex-col gap-3 text-md [overflow-wrap:anywhere] ${muted ? "text-ink-muted" : "text-ink"}`}>
      {text.split(/\n{2,}/).map((para, i) => (
        <p key={i} className="whitespace-pre-line">
          {para}
        </p>
      ))}
    </div>
  );
}

/** Le note di una riunione registrata (`kind: "transcript"`). */
function MeetingBlock({ message }: { message: MailMessageView }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const note = message.meeting;
  if (!note) return null;
  const event = note.event;
  const time = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(iso));
  return (
    <div data-meeting className="flex max-w-[68ch] flex-col gap-2 border-l border-rule-strong pl-3">
      <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-ink">
        <VideoGlyph />
        <span className="font-semibold">{t("mail.meeting.recorded")}</span>
        <span className="text-ink-muted">
          ·{" "}
          {event ? (
            <a href={`#/calendar?event=${encodeURIComponent(event.id)}`} className="text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink">
              {event.title}
            </a>
          ) : (
            (note.docTitle ?? message.subject)
          )}
          {event && (
            <>
              {" · "}
              <span className="num">
                {relativeDay(event.startsAt, i18n.language, {
                  today: t("mail.when.today"),
                  yesterday: t("mail.when.yesterday"),
                })}{" "}
                {time(event.startsAt)}–{time(event.endsAt)}
              </span>
              {" · "}
              {t("mail.meeting.people", { count: event.people })}
            </>
          )}
        </span>
      </p>
      {!note.visible ? (
        <p className="text-sm text-ink-muted">{t("mail.meeting.notVisible")}</p>
      ) : note.doc === "reading" ? (
        <p role="status" className="flex items-center gap-2 text-sm text-ink-muted">
          <WorkingRing size={10} />
          {t("mail.meeting.reading")}
        </p>
      ) : note.doc === "unreachable" ? (
        <p className="flex items-start gap-1.5 text-sm text-critical">
          <span className="mt-0.5">
            <AlertGlyph size={14} />
          </span>
          {t("mail.meeting.unreachable")}
        </p>
      ) : (
        <>
          <p className="flex items-baseline gap-2">
            <span className="heading-group">{t("mail.meeting.summary")}</span>
            <span className="text-xs text-ink-faint">{t("mail.meeting.generated")}</span>
          </p>
          {note.summary && <p className="text-md text-ink">{note.summary}</p>}
          <button
            type="button"
            onClick={() => toast.show(t("mail.meeting.transcriptNotice"))}
            className="self-start rounded-sm text-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
          >
            {t("mail.meeting.open")}
          </button>
        </>
      )}
    </div>
  );
}

/** Le righe dell'analisi sotto il messaggio: in lettura, fallita («Repropose»), niente da fare. */
function Analysis({
  message,
  nothingFor,
  onRepropose,
  reproposing,
}: {
  message: MailMessageView;
  nothingFor: readonly string[];
  onRepropose: () => void;
  reproposing: boolean;
}) {
  const { t } = useTranslation();
  const c = message.classification;
  if (c.state === "pending" || reproposing) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-ink-muted">
        <WorkingRing size={10} />
        {t("mail.analysis.pending")}
      </p>
    );
  }
  if (c.state === "failed") {
    return (
      <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-critical">
        <AlertGlyph size={14} />
        {t("mail.analysis.failed")}
        <button
          type="button"
          onClick={onRepropose}
          className="inline-flex h-7 items-center rounded-md border border-rule-strong px-2.5 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
        >
          {t("mail.repropose")}
        </button>
      </p>
    );
  }
  if (nothingFor.length === 0) return null;
  return (
    <>
      {nothingFor.map((code) => (
        <p key={code} className="text-xs text-ink-faint">
          {t("mail.analysis.nothing", { code })}
        </p>
      ))}
    </>
  );
}

/** Quanto resta «Sent» sotto un messaggio appena partito. */
export const SENT_NOTE_MS = 3000;

/** La ragione di un invio fallito, in parole: «address not found (luca@bounce.example)». */
function failureReason(error: string | undefined, t: (key: string, o?: Record<string, unknown>) => string) {
  const found = /^address_not_found: (.+)$/.exec(error ?? "");
  return found
    ? t("mail.compose.reason.addressNotFound", { email: found[1] })
    : t("mail.compose.reason.other");
}

/**
 * Lo stato di un mio invio sotto il messaggio (shape mail-compose §5 [A 12]):
 * «Sending…» con l'anello nei 5 s, «Sent» per 3 s quando parte, «Not sent»
 * col perché e «Retry» · «Edit» · «Delete» se fallisce — mai un nuovo
 * tentativo da solo. Lo vede solo chi l'ha scritto (il livello dati).
 */
function Delivery({
  message,
  actions,
}: {
  message: MailMessageView;
  actions?: DeliveryActions;
}) {
  const { t } = useTranslation();
  const state = message.delivery?.state;
  const previous = useRef(state);
  const [justSent, setJustSent] = useState(false);
  useEffect(() => {
    const was = previous.current;
    previous.current = state;
    if (was !== "sending" || state !== "sent") return;
    setJustSent(true);
    const timer = window.setTimeout(() => setJustSent(false), SENT_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  if (state === "sending") {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-ink-muted">
        <WorkingRing size={10} />
        {t("mail.compose.sending")}
      </p>
    );
  }
  if (state === "failed") {
    const link =
      "rounded-sm font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink disabled:opacity-40";
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <p role="alert" className="flex items-center gap-1.5 text-critical">
          <AlertGlyph size={14} />
          {t("mail.compose.notSent", { reason: failureReason(message.delivery?.error, t) })}
        </p>
        {actions && (
          <span className="flex items-center gap-2 text-ink-muted">
            <button type="button" className={link} disabled={actions.busy} onClick={actions.onRetry}>
              {t("mail.compose.retry")}
            </button>
            <span aria-hidden="true">·</span>
            <button type="button" className={link} disabled={actions.busy} onClick={actions.onEdit}>
              {t("mail.compose.edit")}
            </button>
            <span aria-hidden="true">·</span>
            <button type="button" className={link} disabled={actions.busy} onClick={actions.onDelete}>
              {t("mail.compose.delete")}
            </button>
          </span>
        )}
      </div>
    );
  }
  if (justSent) return <p className="text-xs text-ink-muted">{t("mail.compose.sent")}</p>;
  return null;
}

/** I comandi di un mio invio fallito. */
export interface DeliveryActions {
  onRetry: () => void;
  onEdit: () => void;
  onDelete: () => void;
  busy: boolean;
}

export function MessageView({
  message,
  expanded,
  onToggle,
  found,
  people,
  projectId,
  nothingFor,
  onRepropose,
  reproposing,
  original,
  onOriginal,
  delivery,
  children,
}: {
  message: MailMessageView;
  expanded: boolean;
  onToggle: () => void;
  /** Il messaggio trovato dalla ricerca: tinta per 2 s. */
  found: boolean;
  people: ReadonlyMap<string, Person>;
  /** Il progetto della conversazione (per «Save to Drive»), se ne ha uno solo. */
  projectId: string | null;
  /** I codici dei progetti per cui il modello non ha nulla da fare. */
  nothingFor: readonly string[];
  onRepropose: () => void;
  reproposing: boolean;
  /** L'originale HTML al posto del testo («Show original»; anche con O). */
  original: boolean;
  onOriginal: (on: boolean) => void;
  /** I comandi di un mio invio fallito («Retry», «Edit», «Delete»). */
  delivery?: DeliveryActions;
  /** Le schede delle proposte nate da questo messaggio. */
  children?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [quoted, setQuoted] = useState(false);
  const headingId = useId();
  const from = message.from;

  if (!expanded) {
    return (
      <article aria-labelledby={headingId} data-message={message.id} data-collapsed className="border-b border-rule">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={false}
          className="flex h-10 w-full min-w-0 items-center gap-2.5 px-1 text-left text-sm transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
        >
          <Avatar address={from} people={people} size={24} />
          <span id={headingId} className={`shrink-0 ${message.read ? "font-medium" : "font-semibold"} text-ink`}>
            {nameOf(from)}
          </span>
          <span className="min-w-0 flex-1 truncate text-ink-muted">{message.text.replace(/\s+/g, " ")}</span>
          <span className="num shrink-0 text-xs text-ink-muted">{whenLabel(message.at, i18n.language)}</span>
        </button>
      </article>
    );
  }

  return (
    <article
      aria-labelledby={headingId}
      data-message={message.id}
      className={`flex flex-col gap-3 border-b border-rule py-4 ${found ? "claude-touch" : ""}`}
    >
      <header className="flex min-w-0 items-start gap-3">
        <Avatar address={from} people={people} size={32} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={true}
            className="flex min-w-0 items-baseline gap-2 text-left"
          >
            <span id={headingId} className="shrink-0 text-md font-semibold text-ink">
              {nameOf(from)}
            </span>
            <span className="min-w-0 truncate text-sm text-ink-muted">{from.email}</span>
          </button>
          <Recipients message={message} />
        </div>
        <span className="num shrink-0 pt-0.5 text-xs text-ink-muted" title={whenWithTime(message.at, i18n.language)}>
          {whenLabel(message.at, i18n.language)}
        </span>
        {message.html && (
          <MenuButton
            menuLabel={t("mail.message.menu")}
            ariaLabel={t("mail.message.menu")}
            align="right"
            className="grid size-7 shrink-0 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/10"
            label={<MoreGlyph />}
          >
            {(close) => (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={itemClass}
                onClick={() => {
                  onOriginal(!original);
                  close();
                }}
              >
                {original ? t("mail.message.showText") : t("mail.message.showOriginal")}
              </button>
            )}
          </MenuButton>
        )}
      </header>
      <div className="flex min-w-0 flex-col gap-3 pl-11">
        {message.context && <p className="text-xs text-ink-muted">{t("mail.message.context")}</p>}
        <MeetingBlock message={message} />
        {original && message.html ? (
          <UntrustedHtmlFrame html={message.html} title={t("mail.message.originalTitle", { name: nameOf(from) })} />
        ) : (
          <Body text={message.text} muted={message.delivery?.state === "sending"} />
        )}
        <Delivery message={message} actions={delivery} />
        {message.html && (
          <button
            type="button"
            onClick={() => onOriginal(!original)}
            className="self-start rounded-sm text-xs font-medium text-ink-muted underline decoration-ink/30 underline-offset-2 hover:text-ink"
          >
            {original ? t("mail.message.showText") : t("mail.message.showOriginal")}
          </button>
        )}
        {message.quoted && (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              aria-expanded={quoted}
              onClick={() => setQuoted((v) => !v)}
              title={quoted ? t("mail.message.hideQuoted") : t("mail.message.showQuoted")}
              className="self-start rounded-md border border-rule px-2 text-sm leading-5 text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
            >
              <span aria-hidden="true">···</span>
              <span className="sr-only">{quoted ? t("mail.message.hideQuoted") : t("mail.message.showQuoted")}</span>
            </button>
            {quoted && (
              <blockquote className="max-w-[68ch] border-l border-rule-strong pl-3 text-sm whitespace-pre-line text-ink-muted">
                {message.quoted}
              </blockquote>
            )}
          </div>
        )}
        {message.attachments.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {message.attachments.map((a) => (
              <li key={a.id} className="group flex h-8 max-w-64 items-center gap-1 rounded-md border border-rule-strong pr-1 pl-2">
                <button
                  type="button"
                  onClick={() => toast.show(t("mail.message.attachmentNotice"))}
                  aria-label={t("mail.message.attachment", { name: a.name, size: formatSize(a.sizeBytes, i18n.language) })}
                  className="flex min-w-0 items-center gap-1.5 text-sm text-ink"
                >
                  <span className="text-ink-muted">
                    <TypeGlyph type={/\.pdf$/i.test(a.name) ? "pdf" : /\.(csv|xlsx?)$/i.test(a.name) ? "sheet" : "other"} />
                  </span>
                  <span className="min-w-0 truncate">{a.name}</span>
                  <span className="num shrink-0 text-xs text-ink-faint">{formatSize(a.sizeBytes, i18n.language)}</span>
                </button>
                {projectId && (
                  <span className="opacity-0 transition-opacity duration-[var(--duration-fast)] group-focus-within:opacity-100 group-hover:opacity-100">
                    <SaveToDriveButton
                      attachment={{ id: a.id, name: a.name, sizeBytes: a.sizeBytes, kind: "file" }}
                      projectId={projectId}
                    />
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {!message.context && (
          <Analysis message={message} nothingFor={nothingFor} onRepropose={onRepropose} reproposing={reproposing} />
        )}
        {children}
      </div>
    </article>
  );
}

