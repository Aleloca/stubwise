import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePeople, type SupportConversationView } from "../../data/queries";
import type { SupportMessage } from "../../data/types";
import { Avatar } from "../../tasks-ui/PersonChip";
import { clock } from "../claude/conversation/parts";
import { whenWithTime } from "../mail/format";
import { customerName } from "./format";
import type { PendingReply } from "./replyStore";

// La conversazione col cliente (shape support.md §3, [A 6], [A 8]): niente
// bolle, avatar 24 px, nome 600, ora in cifre tabellari. Tre voci distinte
// per forma e NOME, mai solo per colore: il cliente (l'iniziale su tinta),
// l'assistente del triage (il segno CL, testo attenuato, la domanda «è
// questo?» citata con un filetto) e il team (la persona, «Inviata al
// cliente…»). Una conversazione lunga apre i primi 3 e gli ultimi 10.

const HEAD = 3;
const TAIL = 10;

/** La domanda «è questo?» del triage: il desiderio proposto, fra virgolette, si cita a parte. */
function splitQuote(body: string): { lead: string; quote: string | null } {
  const m = /^(.*?)[“"]([^”"]+)[”"]\s*$/s.exec(body);
  return m ? { lead: m[1]!.trim(), quote: m[2]! } : { lead: body, quote: null };
}

function CustomerAvatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-6 shrink-0 place-items-center rounded-full bg-ink/6 text-xs font-semibold text-ink"
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

function TriageAvatar() {
  return (
    <span className="grid size-6 shrink-0 place-items-center" aria-hidden="true">
      <span className="grid size-4 place-items-center rounded-full border border-dashed border-claude text-[8px] leading-none font-semibold text-ink">
        CL
      </span>
    </span>
  );
}

function Message({
  m,
  conv,
  pending,
  liRef,
}: {
  m: Pick<SupportMessage, "from" | "authorId" | "body" | "at">;
  conv: SupportConversationView;
  /** Il mio invio nella finestra dell'«Annulla»: «Sending…» al posto dell'ora. */
  pending?: boolean;
  /** L'ultimo messaggio: il fuoco ci va dopo l'invio (shape §6). */
  liRef?: React.RefObject<HTMLLIElement | null>;
}) {
  const { t, i18n } = useTranslation();
  const people = usePeople().data;
  const person = m.authorId ? people?.find((p) => p.id === m.authorId) : undefined;
  const name =
    m.from === "customer"
      ? customerName(conv, t)
      : m.from === "triage"
        ? t("support.message.assistant")
        : (person?.name ?? t("support.message.team"));
  const { lead, quote } = m.from === "triage" ? splitQuote(m.body) : { lead: m.body, quote: null };
  return (
    <li
      ref={liRef}
      tabIndex={liRef ? -1 : undefined}
      className="event-enter flex gap-3 rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus"
      data-support-message={m.from}
    >
      {m.from === "customer" ? (
        <CustomerAvatar name={name} />
      ) : m.from === "triage" ? (
        <TriageAvatar />
      ) : (
        <span className="grid size-6 place-items-center">
          <Avatar person={person} />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-md font-semibold text-ink">{name}</span>
          {!pending && (
            <time dateTime={m.at} className="num shrink-0 text-xs text-ink-faint">
              {clock(m.at, i18n.language)}
            </time>
          )}
        </p>
        <p
          className={`max-w-[72ch] text-md whitespace-pre-wrap [overflow-wrap:anywhere] ${m.from === "triage" ? "text-ink-muted" : "text-ink"}`}
        >
          {lead}
        </p>
        {quote && (
          <blockquote className="mt-1 max-w-[72ch] border-l border-rule-strong pl-3 text-md text-ink">
            {quote}
          </blockquote>
        )}
        {m.from === "team" &&
          (pending ? (
            <p className="text-xs text-ink-muted">{t("support.message.sending")}</p>
          ) : (
            <p className="text-xs text-ink-faint">
              {t(
                conv.channel === "widget"
                  ? "support.message.sentWidget"
                  : "support.message.sentMcp",
              )}
            </p>
          ))}
      </div>
    </li>
  );
}

export function Messages({
  conv,
  pending,
  lastSentRef,
}: {
  conv: SupportConversationView;
  /** Il mio invio nella finestra dell'«Annulla»: in fondo, come mio. */
  pending: PendingReply | null;
  /** L'ultimo messaggio: il fuoco ci va dopo l'invio. */
  lastSentRef: React.RefObject<HTMLLIElement | null>;
}) {
  const { t, i18n } = useTranslation();
  const [all, setAll] = useState(false);
  const list = conv.messages;
  const folded = !all && list.length > HEAD + TAIL;
  const hidden = list.length - HEAD - TAIL;
  const shown = folded ? [...list.slice(0, HEAD), null, ...list.slice(-TAIL)] : list;
  const lastCustomer = list.at(-1)?.from === "customer" ? list.at(-1)!.id : null;
  return (
    <ol aria-label={t("support.message.label")} className="flex flex-col gap-5">
      {shown.map((m, i) =>
        m === null ? (
          <li key="fold" className="flex items-center gap-3">
            <span aria-hidden="true" className="h-px flex-1 bg-rule" />
            <button
              type="button"
              onClick={() => setAll(true)}
              className="num rounded-full border border-rule-strong px-3 py-1 text-xs font-medium text-ink hover:bg-ink/6"
            >
              {t("support.message.earlier", { count: hidden })}
            </button>
            <span aria-hidden="true" className="h-px flex-1 bg-rule" />
          </li>
        ) : (
          <Message
            key={m.id ?? i}
            m={m}
            conv={conv}
            liRef={i === shown.length - 1 ? lastSentRef : undefined}
          />
        ),
      )}
      {/* Partito e già riletto: c'è il messaggio vero (per id), non lo si ripete. */}
      {pending && !(pending.deliveredId && list.some((m) => m.id === pending.deliveredId)) && (
          <Message
            m={{ from: "team", authorId: pending.personId, body: pending.body, at: "" }}
            conv={conv}
            pending
          />
        )}
      {/* Un nuovo messaggio del cliente si annuncia (shape §7). */}
      <li className="sr-only" aria-live="polite">
        {lastCustomer
          ? t("support.message.newFrom", {
              name: customerName(conv, t),
              time: whenWithTime(list.at(-1)!.at, i18n.language),
            })
          : ""}
      </li>
    </ol>
  );
}
