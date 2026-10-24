import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatEventKind, ChatMessageView } from "../../data/types";
import { CitationLink, refKey, useCitationIndex } from "../claude/conversation/citations";
import { DisclosureGlyph } from "../claude/conversation/parts";
import { hm } from "./flow";

// Un evento di progetto nel flusso: l'unica cosa (con le proposte di Claude
// nel thread) che ha un contorno. Alta una o due righe: l'intestazione 12px
// tenue «Release page published · 09:02», poi la riga di catalogo
// dell'oggetto (codice tabellare + nome) e «Open». Eventi dello stesso tipo entro 10 minuti: una sola scheda
// («3 tasks closed») con l'elenco che si apre. Mai più spazio di un
// messaggio di persona.

function EventRow({ message }: { message: ChatMessageView }) {
  const { t } = useTranslation();
  const index = useCitationIndex();
  const ref = message.event?.ref;
  const view = ref ? index.byRef.get(refKey(ref)) : undefined;
  return (
    <span className="flex min-w-0 items-baseline gap-3 text-sm">
      <span className="min-w-0 flex-1 truncate">
        {view ? (
          // Invisibile: il solo codice tenue, che non si apre (R-E9, `CitationLink`).
          <CitationLink view={view} />
        ) : (
          // Finché l'oggetto non è letto: una riga scheletro — mai il testo
          // salvato (porterebbe il titolo anche a chi non lo vede), né il tipo,
          // che l'intestazione dice già.
          <span
            aria-hidden="true"
            data-event-pending
            className="inline-block h-3 w-48 max-w-full rounded-sm bg-ink/8 align-middle"
          />
        )}
      </span>
      {view?.visible && view.route && (
        <a
          href={view.route}
          className="shrink-0 rounded-[3px] text-sm font-medium text-ink-muted underline decoration-transparent underline-offset-2 hover:text-ink hover:decoration-ink/60"
          aria-label={t("chat.system.openNamed", {
            name: [view.code, view.name].filter(Boolean).join(" "),
          })}
        >
          {t("chat.system.open")}
        </a>
      )}
    </span>
  );
}

export function SystemCard({
  eventKind,
  messages,
}: {
  eventKind: ChatEventKind | null;
  messages: ChatMessageView[];
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const first = messages[0]!;
  const last = messages.at(-1)!;
  const kind = eventKind ?? "release_page";
  const many = messages.length > 1;
  return (
    <div
      data-system-card={eventKind ?? "event"}
      className="event-enter my-1 ml-2 flex max-w-[560px] min-w-0 flex-col gap-0.5 rounded-lg border border-rule-strong px-3 py-1.5"
    >
      <p className="flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
        {many ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((o) => !o)}
            className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 hover:bg-ink/6 hover:text-ink"
          >
            <DisclosureGlyph open={open} />
            {t(`chat.system.many.${kind}`, { count: messages.length })}
          </button>
        ) : (
          <span>{t(`chat.system.kinds.${kind}`)}</span>
        )}
        <span aria-hidden="true">·</span>
        <time className="num" dateTime={last.createdAt}>
          {many
            ? `${hm(first.createdAt, i18n.language)}–${hm(last.createdAt, i18n.language)}`
            : hm(first.createdAt, i18n.language)}
        </time>
      </p>
      {many ? (
        open && (
          <ul id={listId} className="flex min-w-0 flex-col gap-1">
            {messages.map((m) => (
              <li key={m.id} className="min-w-0">
                <EventRow message={m} />
              </li>
            ))}
          </ul>
        )
      ) : (
        <EventRow message={first} />
      )}
    </div>
  );
}
