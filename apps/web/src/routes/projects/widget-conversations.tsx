import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { Markdown } from "../../components/markdown";
import type {
  WidgetConversationMessage,
  WidgetConversationSummary,
} from "../../lib/api";
import { formatRelativeTime } from "../../lib/format";
import {
  projectQueryOptions,
  widgetConversationMessagesQueryOptions,
  widgetConversationsQueryOptions,
  widgetsQueryOptions,
} from "../../lib/queries";

/**
 * Search param della pagina Conversazioni: `ticketId` (link "Vedi conversazione"
 * dal dettaglio ticket) e `widgetId` (select di filtro in testa alla lista),
 * entrambi opzionali e componibili. `.catch(undefined)` scarta un URL scritto a
 * mano malformato invece di mandare la route in errore.
 */
export const widgetConversationsSearchSchema = z.object({
  ticketId: z.uuid().optional().catch(undefined),
  widgetId: z.uuid().optional().catch(undefined),
});

// L'id della route include il layout autenticato (id "authed").
const route = getRouteApi("/authed/projects/$projectId/conversations");

/**
 * Una citazione della risposta RAG con un titolo mostrabile. Il campo `citations`
 * di un messaggio è jsonb a forma libera (`unknown`): questo type guard estrae
 * solo gli elementi che sono oggetti con un `title` stringa, ignorando il resto.
 */
interface CitationWithTitle {
  title: string;
}

function citationTitles(citations: unknown): string[] {
  if (!Array.isArray(citations)) return [];
  return citations
    .filter(
      (c): c is CitationWithTitle =>
        typeof c === "object" &&
        c !== null &&
        "title" in c &&
        typeof (c as { title: unknown }).title === "string",
    )
    .map((c) => c.title);
}

/** Nome mostrabile di una conversazione: nome, poi email, poi id esterno. */
function displayName(conv: {
  externalUserName: string | null;
  externalUserEmail: string | null;
  externalUserId: string;
}): string {
  return conv.externalUserName || conv.externalUserEmail || conv.externalUserId;
}

/**
 * Viewer read-only delle conversazioni del widget di un progetto: lista a
 * sinistra (identità + data ultimo messaggio + badge messaggi/ticket), filo
 * dettaglio a destra con ruoli distinti e citazioni/link ai ticket sotto le
 * risposte dell'assistente. Con `?ticketId` la lista è filtrata alla sola
 * conversazione che contiene quel ticket e la si auto-seleziona.
 */
export function WidgetConversationsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { projectId } = route.useParams();
  const { ticketId, widgetId } = route.useSearch();

  const { data: project } = useSuspenseQuery(projectQueryOptions(projectId));
  const { data } = useSuspenseQuery(
    widgetConversationsQueryOptions(projectId, { ticketId, widgetId }),
  );
  const { data: widgetsData } = useSuspenseQuery(widgetsQueryOptions(projectId));
  const conversations = data.conversations;
  const widgets = widgetsData.widgets;

  // Selezione: con `?ticketId` si auto-seleziona la conversazione trovata (la
  // lista è già ristretta a quella); altrimenti resta a scelta dell'utente. La
  // dipendenza sull'elenco riallinea la selezione se il filtro/l'elenco cambia.
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (ticketId && conversations.length > 0) {
      setSelectedId(conversations[0]!.id);
    }
  }, [ticketId, conversations]);

  return (
    <div className="page">
      <Link
        to="/projects/$projectId"
        params={{ projectId }}
        className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
      >
        {t("widget:conversations.back")}
      </Link>

      <header className="mt-3 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="text-xl font-semibold">{t("widget:conversations.title")}</h1>
          <p className="mt-2 font-mono text-[12px] text-fg-muted">{project.name}</p>
        </div>
        {widgets.length > 0 && (
          <label className="flex flex-col gap-1.5 font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">
            {t("widget:conversations.filterLabel")}
            <select
              value={widgetId ?? ""}
              onChange={(event) => {
                const next = event.target.value || undefined;
                void navigate({
                  to: "/projects/$projectId/conversations",
                  params: { projectId },
                  search: (prev) => ({ ...prev, widgetId: next }),
                });
              }}
              className="rounded-sm border border-line-strong bg-ink-900 px-2 py-1.5 text-[12px] tracking-normal text-fg normal-case"
            >
              <option value="">{t("widget:conversations.filterAll")}</option>
              {widgets.map((widget) => (
                <option key={widget.id} value={widget.id}>
                  {widget.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {conversations.length === 0 ? (
        <div className="mt-6 grid place-items-center rounded-sm border border-dashed border-line-strong py-16">
          <p className="font-mono text-[12px] tracking-[0.16em] text-fg-faint uppercase">
            {t("widget:conversations.empty")}
          </p>
        </div>
      ) : (
        <div className="mt-6 grid items-start gap-8 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <ul className="rounded-sm border border-line bg-ink-900">
            {conversations.map((conv) => (
              <li key={conv.id} className="border-b border-line last:border-b-0">
                <button
                  type="button"
                  onClick={() => setSelectedId(conv.id)}
                  aria-current={conv.id === selectedId}
                  className={`flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors hover:bg-ink-850 ${
                    conv.id === selectedId ? "bg-ink-850" : ""
                  }`}
                >
                  <span className="truncate text-sm font-medium text-fg">
                    {displayName(conv)}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-fg-faint">
                    <span>{formatRelativeTime(conv.lastMessageAt)}</span>
                    <span
                      className={`rounded-sm border px-1.5 py-px ${
                        conv.widgetName
                          ? "border-line-strong text-fg-muted"
                          : "border-danger/40 text-danger"
                      }`}
                    >
                      {conv.widgetName ?? t("widget:conversations.widgetDeleted")}
                    </span>
                    <span className="rounded-sm border border-line-strong px-1.5 py-px">
                      {t("widget:conversations.messageCount", { count: conv.messageCount })}
                    </span>
                    {conv.ticketCount > 0 && (
                      <span className="rounded-sm border border-signal-dim/40 px-1.5 py-px text-signal">
                        {t("widget:conversations.ticketCount", { count: conv.ticketCount })}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className="min-w-0">
            {selectedId === undefined ? (
              <div className="grid place-items-center rounded-sm border border-dashed border-line-strong py-16">
                <p className="font-mono text-[12px] tracking-[0.16em] text-fg-faint uppercase">
                  {t("widget:conversations.selectHint")}
                </p>
              </div>
            ) : (
              <ConversationDetail
                projectId={projectId}
                conversationId={selectedId}
                summary={conversations.find((c) => c.id === selectedId)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Filo di una conversazione selezionata: header con l'identità completa e i
 * messaggi in ordine cronologico, con ruoli visivamente distinti. useQuery (non
 * suspense) così un caricamento/errore del pannello non blocca la lista.
 */
function ConversationDetail({
  projectId,
  conversationId,
  summary,
}: {
  projectId: string;
  conversationId: string;
  summary: WidgetConversationSummary | undefined;
}) {
  const { t } = useTranslation();
  const { data, isPending, isError } = useQuery(
    widgetConversationMessagesQueryOptions(projectId, conversationId),
  );

  if (isPending) {
    return (
      <p className="font-mono text-[12px] text-fg-faint">{t("widget:conversations.loading")}</p>
    );
  }
  if (isError || !data) {
    return (
      <p role="alert" className="font-mono text-[12px] text-danger">
        {t("widget:conversations.loadError")}
      </p>
    );
  }

  const { conversation, messages } = data;
  const name = displayName(conversation);
  // Email/id sono metadati secondari sotto il nome; si evita di ripeterli quando
  // coincidono col nome già mostrato in testa.
  const email = conversation.externalUserEmail;
  const showEmail = email && email !== name;

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-fg">{name}</h2>
          <span
            className={`rounded-sm border px-1.5 py-px font-mono text-[11px] ${
              conversation.widgetName
                ? "border-line-strong text-fg-muted"
                : "border-danger/40 text-danger"
            }`}
          >
            {conversation.widgetName ?? t("widget:conversations.widgetDeleted")}
          </span>
        </div>
        <dl className="mt-1.5 space-y-0.5">
          {showEmail && (
            <div className="flex gap-2 font-mono text-[11px] text-fg-muted">
              <dt className="text-fg-faint">{t("widget:conversations.email")}</dt>
              <dd className="break-all">{email}</dd>
            </div>
          )}
          <div className="flex gap-2 font-mono text-[11px] text-fg-muted">
            <dt className="text-fg-faint">{t("widget:conversations.externalId")}</dt>
            <dd className="break-all">{conversation.externalUserId}</dd>
          </div>
        </dl>
      </header>

      <div className="space-y-4 px-4 py-4">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {messages.length === 0 && (
          <p className="font-mono text-[12px] text-fg-faint">
            {t("widget:conversations.noMessages")}
          </p>
        )}
      </div>

      {summary && (
        <footer className="border-t border-line px-4 py-2 font-mono text-[11px] text-fg-faint">
          {formatRelativeTime(summary.lastMessageAt)}
        </footer>
      )}
    </section>
  );
}

/**
 * Un singolo messaggio del filo. L'utente è allineato a destra su sfondo tenue,
 * l'assistente a sinistra col bordo d'accento. Sotto le risposte dell'assistente:
 * le citazioni (fonte: <title>) e l'eventuale link al ticket aperto.
 */
function MessageBubble({ message }: { message: WidgetConversationMessage }) {
  const { t } = useTranslation();
  const isUser = message.role === "user";
  const titles = isUser ? [] : citationTitles(message.citations);

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] min-w-0 rounded-sm px-3 py-2 ${
          isUser
            ? "border border-line-strong bg-ink-850"
            : "border-l-2 border-signal-dim bg-ink-950/60"
        }`}
      >
        <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
          {isUser ? t("widget:conversations.roleUser") : t("widget:conversations.roleAssistant")}
        </span>
        <div className="mt-1 text-sm text-fg">
          <Markdown source={message.content} />
        </div>

        {titles.length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {titles.map((title, index) => (
              <li key={index} className="font-mono text-[11px] text-fg-muted">
                {t("widget:conversations.source", { title })}
              </li>
            ))}
          </ul>
        )}

        {message.ticketId && (
          <Link
            to="/tickets/$id"
            params={{ id: message.ticketId }}
            className="mt-2 inline-block font-mono text-[11px] tracking-[0.08em] text-signal uppercase transition-colors hover:text-signal-bright"
          >
            {t("widget:conversations.viewTicket")}
          </Link>
        )}
      </div>
    </div>
  );
}
