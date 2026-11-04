import { Fragment, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { WhoCanLink } from "../../../components/WhoCanLink";
import { Markdown, type LinkRenderer, type TextDecorator } from "../../../tasks-ui/Markdown";
import { Avatar } from "../../../tasks-ui/PersonChip";
import { actionById, useOpenRoutes, usePeople } from "../../../data/queries";
import { DriveAnchor, HiddenCode, hiddenCodesOf, UsedLine, useCitationIndex } from "./citations";
import { CODE_IN_TEXT, type FlowItem } from "./flow";
import { clock } from "./parts";

/**
 * Il testo di Claude: markdown nudo, 14 px, senza bolla. Mentre arriva
 * cresce nello stesso messaggio con un cursore sottile in coda. I codici
 * degli oggetti citati diventano link (codice + nome solo nella riga «Used»
 * in coda: nel testo il nome c'è già).
 */
export function AssistantMessage({
  item,
  streaming,
  showUsed = true,
}: {
  item: Extract<FlowItem, { kind: "assistant" }>;
  /** Il messaggio sta ancora arrivando (la conversazione lavora). */
  streaming: boolean;
  /** La riga «Used:» in coda (la chat dei Docs ha la sua, con il repository). */
  showUsed?: boolean;
}) {
  const { t } = useTranslation();
  const index = useCitationIndex();
  // Gli oggetti citati da questo messaggio che chi guarda non apre: il loro
  // codice nel testo è quello tenue, anche un file del Drive che la vista non
  // nomina più (il codice registrato, R-H5).
  const hidden = useMemo(() => hiddenCodesOf(index, item.refs), [index, item.refs]);
  const decorate = useCallback<TextDecorator>(
    (text, key) => {
      const parts = text.split(new RegExp(`(${CODE_IN_TEXT.source})`, "g"));
      if (parts.length === 1) return text;
      return parts.map((part, i) => {
        if (i % 2 === 1 && hidden.has(part)) return <HiddenCode key={`${key}-${i}`} code={part} />;
        const view = i % 2 === 1 ? index.byCode.get(part) : undefined;
        if (view && !view.visible) return <HiddenCode key={`${key}-${i}`} code={part} />;
        if (!view?.route) return <Fragment key={`${key}-${i}`}>{part}</Fragment>;
        const linkClass =
          "num font-semibold text-ink underline decoration-ink/25 underline-offset-2 hover:decoration-ink/70";
        // Un file del Drive: il clic lo apre (e conta), come dal gettone.
        if (view.kind === "drive") {
          return (
            <DriveAnchor key={`${key}-${i}`} view={view} className={linkClass}>
              {part}
            </DriveAnchor>
          );
        }
        return (
          <a
            key={`${key}-${i}`}
            href={view.route}
            title={view.name ?? undefined}
            className="num font-semibold text-ink underline decoration-ink/25 underline-offset-2 hover:decoration-ink/70"
          >
            {part}
          </a>
        );
      });
    },
    [index, hidden],
  );
  const { event, refs } = item;
  const cursor = streaming && !event.done;
  const link = useInternalLinks(event.text);
  return (
    <div className="event-enter flex min-w-0 flex-col gap-2" data-assistant={event.id}>
      <div className="min-w-0">
        <Markdown
          source={event.text}
          className="[&>ol]:max-w-[68ch] [&>p]:max-w-[68ch] [&>ul]:max-w-[68ch]"
          decorate={decorate}
          link={link}
          codeLabel={t("claude.conversation.codeBlock")}
          tableLabel={t("claude.conversation.table")}
          trailing={
            cursor && (
              <span
                aria-hidden="true"
                data-stream-cursor
                className="stream-caret ml-0.5 inline-block h-4 w-[2px] translate-y-[3px] rounded-[1px] bg-ink"
              />
            )
          }
        />
      </div>
      {showUsed && refs.length > 0 && !cursor && <UsedLine refs={refs} />}
    </div>
  );
}

/** Gli indirizzi dei link markdown di un testo: interni (`#/…`) e i «Who?» (`who:<azione>/<CODE>`). */
const LINK_TARGET = /\]\(((?:#\/|who:)[^)\s]+)\)/g;

/**
 * Un «Who?» di Claude: `who:recordDecision/AUD` → azione e codice del
 * progetto; `who:seeUsage` (area 10b, S3) → un'azione d'istanza, senza codice.
 */
const whoOf = (href: string) => {
  const m = /^who:([A-Za-z]+)(?:\/([A-Z]{2,4}))?$/.exec(href);
  return m ? { action: m[1]!, code: m[2] ?? null } : null;
};

/**
 * I link di una riga D di Claude (area 10a, Task 9): un indirizzo interno è
 * un link solo se chi legge vede la meta (`useOpenRoutes`, che lo dice il
 * livello dati), altrimenti resta l'etichetta; un «Who?» diventa
 * `WhoCanLink`, solo se chi legge vede il progetto (d'istanza sempre, area
 * 10b). Mai una scheda né un bottone che faccia il gesto.
 */
function useInternalLinks(text: string): LinkRenderer {
  const routes = useMemo(() => {
    const out = new Set<string>();
    for (const m of text.matchAll(LINK_TARGET)) {
      const who = whoOf(m[1]!);
      // Un «Who?» d'istanza non ha un progetto da nascondere: nessun controllo.
      if (who?.code === null) continue;
      out.add(who ? `#/p/${who.code}/overview` : m[1]!);
    }
    return [...out];
  }, [text]);
  const open = useOpenRoutes(routes).data;
  return useCallback<LinkRenderer>(
    (href, label, key) => {
      const who = whoOf(href);
      // Senza codice vale solo un'azione d'istanza del catalogo; un'azione di
      // progetto senza codice, o una che il catalogo non ha, resta testo.
      if (who?.code === null) {
        return actionById(who.action)?.scope === "instance" ? (
          <WhoCanLink key={key} action={who.action} projectId={null} />
        ) : (
          <span key={key}>{label}</span>
        );
      }
      if (who) {
        return open?.includes(`#/p/${who.code}/overview`) ? (
          <WhoCanLink key={key} action={who.action} projectCode={who.code} />
        ) : null;
      }
      if (!href.startsWith("#/")) return undefined;
      if (!open?.includes(href)) return <span key={key}>{label}</span>;
      return (
        <a
          key={key}
          href={href}
          className="font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
        >
          {label}
        </a>
      );
    },
    [open],
  );
}

/** Una citazione senza messaggio davanti: la sola riga «Used». */
export function CitationRow({ item }: { item: Extract<FlowItem, { kind: "citation" }> }) {
  return (
    <div className="event-enter">
      <UsedLine refs={item.refs} />
    </div>
  );
}

/** L'inizio di un turno di Claude: l'avatar con l'anello tratteggiato, «Claude · 10:41». */
export function ClaudeHeader({ at, compact }: { at: string; compact: boolean }) {
  const { i18n } = useTranslation();
  const claude = usePeople().data?.find((p) => p.isClaude);
  return (
    <div className="event-enter flex items-center gap-2 pt-2 text-xs text-ink-muted">
      {!compact && <Avatar person={claude} />}
      <span className="font-semibold text-ink">{claude?.name ?? "Claude"}</span>
      <span aria-hidden="true">·</span>
      <time dateTime={at} className="num">
        {clock(at, i18n.language)}
      </time>
    </div>
  );
}
