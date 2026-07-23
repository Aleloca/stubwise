import {
  backlogItemStatusSchema,
  backlogRiskSchema,
  ticketPrioritySchema,
  type BacklogItemStatus,
  type BacklogRisk,
  type TicketPriority,
  type UpdateBacklogItemInput,
} from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode, type SelectHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import {
  BACKLOG_RISK_LABEL_KEYS,
  BACKLOG_STATUS_LABEL_KEYS,
  BacklogStatusBadge,
  PRIORITY_LABEL_KEYS,
} from "../../components/badges";
import { BacklogChat } from "../../components/backlog-chat";
import { ComboboxPicker } from "../../components/combobox-picker";
import { SelectField } from "../../components/field";
import { Markdown } from "../../components/markdown";
import {
  acceptSuggested,
  ApiError,
  convertBacklogItem,
  deleteBacklogDesign,
  deleteBacklogPlan,
  dismissSuggested,
  mergeBacklogItem,
  patchBacklogItem,
  refreshBacklogDocument,
  requestDeepDive,
  startCodeSession,
  stopCodeSession,
  type BacklogItem,
  type BacklogItemBase,
  type BacklogItemDetail,
  type BacklogSuggested,
} from "../../lib/api";
import { meQueryOptions } from "../../lib/auth";
import {
  backlogItemQueryOptions,
  backlogKeys,
  projectsQueryOptions,
  repositoriesQueryOptions,
  ticketKeys,
} from "../../lib/queries";
import { listBacklogItems } from "../../lib/api";

// L'id della route include il layout autenticato (id "authed").
const route = getRouteApi("/authed/backlog/$id");

/** Stati editabili dal select del pannello: solo il ciclo di vita ATTIVO. */
// `converted` non è mai scelto qui (lo imposta solo /convert); `archived` e la
// riattivazione passano dai bottoni dedicati (Archivia/Riapri) per chiarezza.
const EDITABLE_STATUSES: BacklogItemStatus[] = ["new", "refining", "ready"];
const EFFORT_OPTIONS = [1, 2, 3, 4, 5] as const;

const sectionTitleClass =
  "mb-3 font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase";

/**
 * Dettaglio di una voce del backlog di discovery, layout "workspace" su `lg+`:
 * header compatto NON scrollante (titolo + badge, metadati editabili inline e
 * barra azioni con menu "⋯"), poi uno split a piena altezza — documento a
 * sinistra (~60%, scroll proprio) e chat a destra (~40%, piena altezza). La
 * PAGINA non scrolla: scrollano i due pannelli (il `<main>` dell'app-layout è
 * lo scroller, qui riempiamo con `h-full`). Sotto `lg` torna uno stack che
 * scrolla come prima (header, banner, documento, ticket, bottone chat+drawer).
 * Il loader ha precaricato voce e progetti.
 */
export function BacklogDetailPage() {
  const { t } = useTranslation();
  const { id } = route.useParams();
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();

  const { data: item } = useSuspenseQuery(backlogItemQueryOptions(id));
  const { data: projects } = useSuspenseQuery(projectsQueryOptions);
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";

  const projectName = projects.find((project) => project.id === item.projectId)?.name ?? "—";
  const isConverted = item.status === "converted";
  const isArchived = item.status === "archived";
  const isLocked = isConverted || isArchived;

  // Le mutazioni tornano la forma BASE (senza tickets/messages/deepDivePending):
  // si fonde nel dettaglio in cache conservando quei campi, poi si invalida per
  // riconciliare col server. cancelQueries prima del setQueryData evita che un
  // refetch in volo sovrascriva con dati stantii (pattern dettaglio ticket).
  const applyBase = async (updated: BacklogItemBase) => {
    await queryClient.cancelQueries({ queryKey: backlogKeys.detail(id) });
    queryClient.setQueryData(backlogItemQueryOptions(id).queryKey, (prev) =>
      prev ? { ...prev, ...updated } : prev,
    );
    void queryClient.invalidateQueries({ queryKey: backlogKeys.detail(id) });
    void queryClient.invalidateQueries({ queryKey: backlogKeys.lists() });
  };

  const patchMutation = useMutation({
    mutationFn: (patch: UpdateBacklogItemInput) => patchBacklogItem(id, patch),
    onSuccess: applyBase,
  });

  // Repository del progetto: nome del repo nel badge modalità + picker di avvio
  // sessione. Query cache-condivisa con ActionsPanel (stessa chiave). Non-suspense
  // così un caricamento/errore non blocca il dettaglio.
  const { data: chatRepos = [] } = useQuery(repositoriesQueryOptions(item.projectId));

  const [sessionError, setSessionError] = useState<string | null>(null);
  const invalidateDetail = () =>
    void queryClient.invalidateQueries({ queryKey: backlogKeys.detail(id) });

  const startSessionMutation = useMutation({
    mutationFn: (repositoryId: string) => startCodeSession(id, repositoryId),
    onMutate: () => setSessionError(null),
    // Il 201 crea la sessione: rileggi il dettaglio così `codeSession` compare e
    // la chat passa in modalità CODE (badge + messaggio system d'avvio).
    onSuccess: invalidateDetail,
    onError: () => setSessionError(t("backlog:chat.sessionError")),
  });

  const stopSessionMutation = useMutation({
    mutationFn: () => stopCodeSession(id),
    onMutate: () => setSessionError(null),
    onSuccess: invalidateDetail,
    onError: () => setSessionError(t("backlog:chat.sessionError")),
  });
  const sessionPending = startSessionMutation.isPending || stopSessionMutation.isPending;

  // Delete di design/piano: gli endpoint sono requireAuth (non admin) — collegare
  // e scollegare design/piano è lavoro quotidiano come la chat. Tornano la forma
  // BASE (document ripristinato dall'origine / implementationPlan azzerato), che
  // `applyBase` fonde nel dettaglio e poi invalida.
  const deleteDesignMutation = useMutation({
    mutationFn: () => deleteBacklogDesign(id),
    onSuccess: applyBase,
  });
  const deletePlanMutation = useMutation({
    mutationFn: () => deleteBacklogPlan(id),
    onSuccess: applyBase,
  });

  const metaDisabled = !isAdmin || isLocked || patchMutation.isPending;

  return (
    // `.page` per il padding standard; su `lg+` diventa una colonna a piena
    // altezza (`h-full min-h-0`) così lo split figlio può riempire il viewport
    // e delegare lo scroll ai pannelli. Sotto `lg` resta un blocco che cresce
    // e scrolla nel `<main>` (stack mobile).
    <div className="page flex flex-col lg:h-full lg:min-h-0">
      <header className="shrink-0 border-b border-line pb-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Link
            to="/backlog"
            className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
          >
            ← {t("backlog:detail.back")}
          </Link>
          <span className="text-line" aria-hidden>
            /
          </span>
          <h1 className="min-w-0 text-lg font-semibold">{item.title}</h1>
          <BacklogStatusBadge status={item.status} />
          {/* Sorgente con chiavi i18n dedicate al backlog (ticket/manual). */}
          <span
            className="font-mono text-[11px] text-fg-faint"
            title={t("badges:sourceTitle", { label: t(`backlog:source.${item.source}`) })}
          >
            ◇ {t(`backlog:source.${item.source}`)}
          </span>
          <span className="font-mono text-[11px] text-fg-muted">{projectName}</span>
          {item.requestCount > 1 && (
            <span
              className="rounded-sm border border-line px-1.5 py-px font-mono text-[11px] text-signal"
              aria-label={t("backlog:card.requestCount", { count: item.requestCount })}
            >
              ×{item.requestCount}
            </span>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          {/* Metadati editabili inline (orizzontali). getByLabelText continua a
              trovarli: label+select restano associati per id. */}
          <div className="flex min-w-0 flex-wrap items-end gap-x-3 gap-y-2">
            <InlineSelectField
              id="backlog-status"
              label={t("backlog:detail.status")}
              value={EDITABLE_STATUSES.includes(item.status) ? item.status : ""}
              disabled={metaDisabled}
              onChange={(event) =>
                patchMutation.mutate({ status: event.target.value as BacklogItemStatus })
              }
              options={[
                // Stato corrente non-editabile (converted/archived): opzione
                // fantasma così il select mostra il valore reale invece di uno a caso.
                ...(EDITABLE_STATUSES.includes(item.status)
                  ? []
                  : [{ value: "", label: t(BACKLOG_STATUS_LABEL_KEYS[item.status]) }]),
                ...backlogItemStatusSchema.options
                  .filter((status) => EDITABLE_STATUSES.includes(status))
                  .map((status) => ({ value: status, label: t(BACKLOG_STATUS_LABEL_KEYS[status]) })),
              ]}
            />

            <InlineSelectField
              id="backlog-effort"
              label={t("backlog:detail.effort")}
              value={item.effort === null ? "" : String(item.effort)}
              disabled={metaDisabled}
              onChange={(event) =>
                patchMutation.mutate({
                  effort: event.target.value === "" ? null : Number(event.target.value),
                })
              }
              options={[
                { value: "", label: t("backlog:detail.none") },
                ...EFFORT_OPTIONS.map((effort) => ({
                  value: String(effort),
                  label: t("backlog:detail.effortOption", { value: effort }),
                })),
              ]}
            />

            <InlineSelectField
              id="backlog-risk"
              label={t("backlog:detail.risk")}
              value={item.risk ?? ""}
              disabled={metaDisabled}
              onChange={(event) =>
                patchMutation.mutate({
                  risk: event.target.value === "" ? null : (event.target.value as BacklogRisk),
                })
              }
              options={[
                { value: "", label: t("backlog:detail.none") },
                ...backlogRiskSchema.options.map((risk) => ({
                  value: risk,
                  label: t(BACKLOG_RISK_LABEL_KEYS[risk]),
                })),
              ]}
            />

            <InlineSelectField
              id="backlog-urgency"
              label={t("backlog:detail.urgency")}
              value={item.urgency ?? ""}
              disabled={metaDisabled}
              onChange={(event) =>
                patchMutation.mutate({
                  urgency:
                    event.target.value === "" ? null : (event.target.value as TicketPriority),
                })
              }
              options={[
                { value: "", label: t("backlog:detail.none") },
                ...ticketPrioritySchema.options.map((priority) => ({
                  value: priority,
                  label: t(PRIORITY_LABEL_KEYS[priority]),
                })),
              ]}
            />

            <RiskNoteField
              value={item.riskNote ?? ""}
              disabled={metaDisabled}
              onCommit={(riskNote) => patchMutation.mutate({ riskNote: riskNote || null })}
            />
          </div>

          {/*
            key={id}: navigando tra voci (es. dopo una fusione) la route NON
            rimonta il componente pagina — senza key ActionsPanel conserverebbe
            i suoi notice locali (e la chat la storia della voce precedente).
          */}
          {isAdmin && (
            <ActionsPanel
              key={`actions-${id}`}
              item={item}
              projectName={projectName}
              onApply={applyBase}
              navigate={navigate}
            />
          )}
        </div>

        {isLocked && (
          <p className="mt-3 font-mono text-[11px] text-fg-muted">
            {t("backlog:detail.lockedNotice", {
              status: t(BACKLOG_STATUS_LABEL_KEYS[item.status]),
            })}
          </p>
        )}

        {patchMutation.isError && (
          <p role="alert" className="mt-2 font-mono text-[12px] text-danger">
            {patchMutation.error.message}
          </p>
        )}
      </header>

      {/* Banner suggeriti + avviso analisi: a tutta larghezza, subito sotto
          l'header (shrink-0, non entrano nello scroll dei pannelli). */}
      {isAdmin && !isLocked && item.suggested && (
        <div className="mt-4 shrink-0">
          <SuggestedBanner item={item} onApply={applyBase} />
        </div>
      )}
      {item.deepDivePending && (
        <div
          role="status"
          className="mt-4 shrink-0 rounded-sm border border-signal-dim/40 bg-ink-900 px-4 py-3 text-sm text-fg-muted"
        >
          {t("backlog:detail.deepDivePending")}
        </div>
      )}

      {/* Split a piena altezza (lg+): documento ~60% / chat ~40%, scroll
          indipendenti. Sotto lg è uno stack che scrolla nel <main>. Il track
          `minmax(0,1fr)` + i `min-h-0` sui pannelli sono ciò che permette lo
          scroll interno invece di sfondare l'altezza. */}
      <div className="mt-6 flex flex-1 flex-col gap-6 lg:grid lg:min-h-0 lg:grid-cols-[3fr_2fr] lg:grid-rows-[minmax(0,1fr)]">
        <div className="min-w-0 space-y-6 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
          {/* Documento della voce: è il DESIGN se collegato (l'origine è
              preservata in `originContent` e mostrata sotto in un blocco
              collassabile), altrimenti il documento sintetizzato dalla chat. */}
          <section aria-label={t("backlog:detail.design")}>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className={sectionTitleClass}>{t("backlog:detail.design")}</h2>
              {!isLocked && item.originContent !== null && (
                <ConfirmDeleteButton
                  label={t("backlog:detail.deleteDesign")}
                  confirmAria={t("backlog:detail.deleteDesignConfirmAria")}
                  pending={deleteDesignMutation.isPending}
                  onConfirm={() => deleteDesignMutation.mutate()}
                />
              )}
            </div>
            {item.document.trim() === "" ? (
              <p className="font-mono text-[12px] text-fg-faint">{t("backlog:detail.noDocument")}</p>
            ) : (
              <Markdown source={item.document} />
            )}
            {deleteDesignMutation.isError && (
              <p role="alert" className="mt-2 font-mono text-[12px] text-danger">
                {deleteDesignMutation.error.message}
              </p>
            )}
          </section>

          {/* Piano di implementazione: reso in Markdown, con empty state quando
              nessun piano è collegato. Solo render/delete (si crea da Claude Code). */}
          <section aria-label={t("backlog:detail.plan")}>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className={sectionTitleClass}>{t("backlog:detail.plan")}</h2>
              {!isLocked && item.implementationPlan !== null && (
                <ConfirmDeleteButton
                  label={t("backlog:detail.deletePlan")}
                  confirmAria={t("backlog:detail.deletePlanConfirmAria")}
                  pending={deletePlanMutation.isPending}
                  onConfirm={() => deletePlanMutation.mutate()}
                />
              )}
            </div>
            {item.implementationPlan === null ? (
              <p className="font-mono text-[12px] text-fg-faint">{t("backlog:detail.noPlan")}</p>
            ) : (
              <Markdown source={item.implementationPlan} />
            )}
            {deletePlanMutation.isError && (
              <p role="alert" className="mt-2 font-mono text-[12px] text-danger">
                {deletePlanMutation.error.message}
              </p>
            )}
          </section>

          {/* Richiesta originale: presente solo quando un design ha sostituito il
              documento. Collassata di default (dettaglio secondario). */}
          {item.originContent !== null && (
            <details className="rounded-sm border border-line bg-ink-900">
              <summary className="cursor-pointer list-none px-4 py-3 font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase select-none marker:content-none hover:text-fg">
                {t("backlog:detail.originalRequest")}
              </summary>
              <div className="border-t border-line px-4 py-3">
                <Markdown source={item.originContent} />
              </div>
            </details>
          )}

          <section aria-label={t("backlog:detail.linkedTickets")}>
            <h2 className={sectionTitleClass}>{t("backlog:detail.linkedTickets")}</h2>
            {item.tickets.length === 0 ? (
              <p className="font-mono text-[12px] text-fg-faint">
                {t("backlog:detail.noLinkedTickets")}
              </p>
            ) : (
              <ul className="rounded-sm border border-line bg-ink-900">
                {item.tickets.map((ticket) => (
                  <li
                    key={ticket.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-3 last:border-b-0"
                  >
                    <Link
                      to="/tickets/$id"
                      params={{ id: ticket.id }}
                      className="text-sm font-medium text-fg transition-colors hover:text-signal"
                    >
                      <span className="font-mono text-signal">#{ticket.number}</span> {ticket.title}
                    </Link>
                    <span className="rounded-sm border border-line px-1.5 py-px font-mono text-[10px] tracking-[0.08em] text-fg-faint uppercase">
                      {t(
                        ticket.role === "origin"
                          ? "backlog:detail.roleOrigin"
                          : "backlog:detail.roleConverted",
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Chat: su lg riempie la cella destra (h-full interno); su mobile è il
            bottone che apre il drawer. La cella grid dà l'altezza (stretch sul
            track 1fr), il componente ci si adatta. */}
        <BacklogChat
          key={`chat-${id}`}
          itemId={id}
          serverMessages={item.messages}
          onExchangeComplete={invalidateDetail}
          codeSession={item.codeSession}
          pendingTurn={item.pendingTurn}
          repos={chatRepos}
          onStartSession={(repositoryId) => startSessionMutation.mutate(repositoryId)}
          onStopSession={() => stopSessionMutation.mutate()}
          sessionPending={sessionPending}
          sessionError={sessionError}
        />
      </div>
    </div>
  );
}

/** Label mono maiuscoletto compatta, condivisa dai controlli inline dell'header. */
const inlineLabelClass =
  "font-mono text-[10px] font-medium tracking-[0.12em] text-fg-faint uppercase";

/**
 * Select compatto dell'header workspace: label piccola sopra un select a
 * larghezza-contenuto (gemello di {@link SelectField} ma senza full-width), così
 * i quattro metadati stanno in fila. label+select restano associati via `id`.
 */
function InlineSelectField({
  id,
  label,
  options,
  ...selectProps
}: {
  id: string;
  label: string;
  options: { value: string; label: string }[];
} & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={inlineLabelClass}>
        {label}
      </label>
      <select
        id={id}
        className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim disabled:cursor-not-allowed disabled:opacity-50"
        {...selectProps}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Nota sul rischio: campo compatto inline (una riga, espandibile) che invia la
 * PATCH al blur se cambiata. Stessa `id`/label di prima, così resta labelabile.
 */
function RiskNoteField({
  value,
  disabled,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);

  // Riallinea il draft quando il valore cambia da fuori (accept suggested, refetch).
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value);
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="backlog-risk-note" className={inlineLabelClass}>
        {t("backlog:detail.riskNote")}
      </label>
      <textarea
        id="backlog-risk-note"
        rows={1}
        value={draft}
        disabled={disabled}
        placeholder={t("backlog:detail.riskNotePlaceholder")}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next !== value.trim()) onCommit(next);
        }}
        className="w-52 resize-y rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1 text-[12px] text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim disabled:cursor-not-allowed disabled:opacity-50"
      />
    </div>
  );
}

/**
 * Bottone di rimozione a due passi (pattern access-tokens): il primo click
 * rivela "Conferma"/"Annulla"; solo il secondo esegue. Stile terminal, tono
 * danger. Usato per scollegare design e piano dalla voce.
 */
function ConfirmDeleteButton({
  label,
  confirmAria,
  pending,
  onConfirm,
}: {
  label: string;
  /** aria-label del bottone di conferma: distingue design da piano per gli AT. */
  confirmAria: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className={deleteButtonClass}>
        {label}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        aria-label={confirmAria}
        onClick={onConfirm}
        className={deleteButtonClass}
      >
        {t("backlog:detail.confirmRemove")}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="rounded-sm border border-line-strong px-2.5 py-1 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
      >
        {t("backlog:actions.cancel")}
      </button>
    </span>
  );
}

const deleteButtonClass =
  "rounded-sm border border-danger/30 bg-ink-950/70 px-2.5 py-1 font-mono text-[11px] tracking-[0.08em] text-danger uppercase transition-colors hover:border-danger/60 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Banner dei metadati suggeriti dall'AI: mostra i campi proposti col valore
 * attuale a confronto ("effort 4 (era 2)") più l'eventuale motivazione, con
 * Accetta tutti / Ignora. Reso solo all'admin quando la voce è editabile.
 */
function SuggestedBanner({
  item,
  onApply,
}: {
  item: BacklogItemDetail;
  onApply: (updated: BacklogItemBase) => Promise<void>;
}) {
  const { t } = useTranslation();
  const suggested = item.suggested as BacklogSuggested;

  const acceptMutation = useMutation({
    mutationFn: () => acceptSuggested(item.id),
    onSuccess: onApply,
  });
  const dismissMutation = useMutation({
    mutationFn: () => dismissSuggested(item.id),
    onSuccess: onApply,
  });
  const pending = acceptMutation.isPending || dismissMutation.isPending;

  // Confronto "proposto (era attuale)": una riga per ogni campo suggerito.
  const rows: string[] = [];
  const was = (current: string | number | null) =>
    current === null || current === "" ? t("backlog:suggested.wasEmpty") : t("backlog:suggested.was", { value: current });
  if (suggested.effort !== undefined) {
    rows.push(`${t("backlog:suggested.effort", { value: suggested.effort })} (${was(item.effort)})`);
  }
  if (suggested.risk !== undefined) {
    rows.push(
      `${t("backlog:suggested.risk", { value: t(BACKLOG_RISK_LABEL_KEYS[suggested.risk]) })} (${was(
        item.risk ? t(BACKLOG_RISK_LABEL_KEYS[item.risk]) : null,
      )})`,
    );
  }
  if (suggested.urgency !== undefined) {
    rows.push(
      `${t("backlog:suggested.urgency", { value: t(PRIORITY_LABEL_KEYS[suggested.urgency]) })} (${was(
        item.urgency ? t(PRIORITY_LABEL_KEYS[item.urgency]) : null,
      )})`,
    );
  }
  if (suggested.riskNote !== undefined) {
    rows.push(t("backlog:suggested.riskNote"));
  }

  return (
    <section
      aria-label={t("backlog:suggested.title")}
      className="rounded-sm border border-signal-dim/40 bg-ink-900 px-4 py-3"
    >
      <h2 className="font-mono text-[11px] tracking-[0.12em] text-signal uppercase">
        {t("backlog:suggested.title")}
      </h2>
      <p className="mt-1 text-sm text-fg-muted">{t("backlog:suggested.intro")}</p>
      <ul className="mt-2 flex flex-col gap-1">
        {rows.map((row, index) => (
          <li key={index} className="font-mono text-[12px] text-fg">
            {row}
          </li>
        ))}
      </ul>
      {suggested.reason && (
        <p className="mt-2 text-[12px] text-fg-muted">
          <span className="font-mono tracking-[0.08em] text-fg-faint uppercase">
            {t("backlog:suggested.reason")}:
          </span>{" "}
          {suggested.reason}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={() => acceptMutation.mutate()}
          className="rounded-sm bg-signal px-3 py-1.5 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
        >
          {acceptMutation.isPending ? t("backlog:suggested.accepting") : t("backlog:suggested.accept")}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => dismissMutation.mutate()}
          className="rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[12px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
        >
          {dismissMutation.isPending ? t("backlog:suggested.dismissing") : t("backlog:suggested.dismiss")}
        </button>
      </div>
      {(acceptMutation.isError || dismissMutation.isError) && (
        <p role="alert" className="mt-2 font-mono text-[12px] text-danger">
          {(acceptMutation.error ?? dismissMutation.error)?.message}
        </p>
      )}
    </section>
  );
}

/**
 * Barra azioni (solo admin): aggiorna documento, analisi approfondita, esporta,
 * converti, fondi, archivia/riapri. Le azioni di modifica sono nascoste quando
 * la voce è bloccata (converted/archived); archived espone comunque "Riapri".
 */
function ActionsPanel({
  item,
  projectName,
  onApply,
  navigate,
}: {
  item: BacklogItemDetail;
  /** Nome del progetto risolto dalla pagina: finisce nel frontmatter export. */
  projectName: string;
  onApply: (updated: BacklogItemBase) => Promise<void>;
  navigate: ReturnType<typeof route.useNavigate>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isConverted = item.status === "converted";
  const isArchived = item.status === "archived";
  const isLocked = isConverted || isArchived;

  const [repoDialogOpen, setRepoDialogOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [convertedTo, setConvertedTo] = useState<{ ticketId: string; ticketNumber: number } | null>(
    null,
  );
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);

  // Repository del progetto: servono per il deep dive (1 repo → diretto, N →
  // scelta). useQuery non-suspense così un caricamento/errore non blocca la pagina.
  const { data: repos = [] } = useQuery(repositoriesQueryOptions(item.projectId));

  const refreshMutation = useMutation({
    mutationFn: () => refreshBacklogDocument(item.id),
    onMutate: () => setRefreshNotice(null),
    onSuccess: onApply,
    onError: (error) => {
      // 409: niente di nuovo da sintetizzare (messaggio informativo, non un
      // errore vero). 502/altro: generazione fallita, messaggio chiaro.
      if (error instanceof ApiError && error.status === 409) {
        setRefreshNotice(t("backlog:actions.refreshNothingNew"));
      } else {
        setRefreshNotice(t("backlog:actions.refreshFailed"));
      }
    },
  });

  const deepDiveMutation = useMutation({
    mutationFn: (repositoryId: string) => requestDeepDive(item.id, repositoryId),
    onSuccess: () => {
      setRepoDialogOpen(false);
      // Il 202 accoda il job: il dettaglio va riletto perché `deepDivePending`
      // diventi vero (banner + polling adattivo della query).
      void queryClient.invalidateQueries({ queryKey: backlogKeys.detail(item.id) });
    },
  });

  const convertMutation = useMutation({
    mutationFn: () => convertBacklogItem(item.id),
    onSuccess: (result) => {
      setConvertOpen(false);
      setConvertedTo(result);
      void queryClient.invalidateQueries({ queryKey: backlogKeys.detail(item.id) });
      void queryClient.invalidateQueries({ queryKey: backlogKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: ticketKeys.lists() });
    },
  });

  const mergeMutation = useMutation({
    mutationFn: (targetId: string) => mergeBacklogItem(item.id, targetId),
    onSuccess: (_updated, targetId) => {
      setMergeOpen(false);
      // La voce corrente è stata assorbita: si va sulla destinazione.
      void queryClient.invalidateQueries({ queryKey: backlogKeys.lists() });
      void navigate({ to: "/backlog/$id", params: { id: targetId } });
    },
  });

  const statusMutation = useMutation({
    mutationFn: (status: BacklogItemStatus) => patchBacklogItem(item.id, { status }),
    onSuccess: onApply,
  });

  function startDeepDive() {
    if (repos.length === 1) {
      deepDiveMutation.mutate(repos[0]!.id);
    } else {
      setRepoDialogOpen(true);
    }
  }

  function exportMarkdown(): string {
    const originTickets = item.tickets
      .filter((ticket) => ticket.role === "origin")
      .map((ticket) => `#${ticket.number}`)
      .join(", ");
    // I valori stringa liberi (titolo, nome progetto) passano da JSON.stringify:
    // ":" e altri caratteri speciali romperebbero lo YAML se interpolati nudi
    // (JSON è un sottoinsieme di YAML, quindi la stringa quotata è sempre valida).
    const front = [
      "---",
      `title: ${JSON.stringify(item.title)}`,
      `project: ${JSON.stringify(projectName)}`,
      `effort: ${item.effort ?? "-"}`,
      `risk: ${item.risk ?? "-"}`,
      `urgency: ${item.urgency ?? "-"}`,
      `originTickets: ${originTickets || "-"}`,
      "---",
      "",
    ].join("\n");
    // Il piano, se presente, segue il documento come sezione dedicata.
    const plan = item.implementationPlan
      ? `\n\n## ${t("backlog:detail.plan")}\n\n${item.implementationPlan}`
      : "";
    return `${front}${item.document}${plan}`;
  }

  function slugify(value: string): string {
    const slug = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug || "backlog-item";
  }

  async function copyMarkdown() {
    try {
      await navigator.clipboard?.writeText(exportMarkdown());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard non disponibile/negata: nessun crash, il download resta.
    }
  }

  function downloadMarkdown() {
    const blob = new Blob([exportMarkdown()], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slugify(item.title)}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col items-stretch gap-2 lg:items-end">
      {/* Barra azioni orizzontale: primarie visibili + menu "⋯" per le
          secondarie (export/fusione/archivia/riapri). Su voci bloccate le
          azioni di modifica spariscono; l'export resta (sempre nel menu). */}
      <div className="flex flex-wrap items-center gap-2 lg:justify-end">
        {!isLocked && (
          <>
            <button
              type="button"
              disabled={refreshMutation.isPending}
              onClick={() => refreshMutation.mutate()}
              className={actionButtonClass}
            >
              {refreshMutation.isPending
                ? t("backlog:actions.refreshing")
                : t("backlog:actions.refreshDocument")}
            </button>

            <button
              type="button"
              disabled={deepDiveMutation.isPending || item.deepDivePending || repos.length === 0}
              onClick={startDeepDive}
              className={actionButtonClass}
            >
              {t("backlog:actions.deepDive")}
            </button>

            <button
              type="button"
              disabled={convertMutation.isPending}
              onClick={() => setConvertOpen(true)}
              className={actionPrimaryClass}
            >
              {convertMutation.isPending
                ? t("backlog:actions.converting")
                : t("backlog:actions.convert")}
            </button>
          </>
        )}

        <OverflowMenu label={t("backlog:actions.more")}>
          {(close) => (
            <>
              <MenuButton
                onClick={() => {
                  close();
                  void copyMarkdown();
                }}
              >
                {copied ? t("backlog:actions.copied") : t("backlog:actions.copyMd")}
              </MenuButton>
              <MenuButton
                onClick={() => {
                  close();
                  downloadMarkdown();
                }}
              >
                {t("backlog:actions.downloadMd")}
              </MenuButton>
              {!isLocked && (
                <>
                  <MenuButton
                    onClick={() => {
                      close();
                      setMergeOpen(true);
                    }}
                  >
                    {t("backlog:actions.merge")}
                  </MenuButton>
                  <MenuButton
                    disabled={statusMutation.isPending}
                    onClick={() => {
                      close();
                      statusMutation.mutate("archived");
                    }}
                  >
                    {t("backlog:actions.archive")}
                  </MenuButton>
                </>
              )}
              {isArchived && (
                <MenuButton
                  disabled={statusMutation.isPending}
                  onClick={() => {
                    close();
                    statusMutation.mutate("refining");
                  }}
                >
                  {t("backlog:actions.reopen")}
                </MenuButton>
              )}
            </>
          )}
        </OverflowMenu>
      </div>

      {/* Notice/errori delle azioni: sotto la barra, allineati a destra su lg. */}
      <div className="flex flex-col gap-1 lg:items-end lg:text-right">
        {convertedTo && (
          <p className="rounded-sm border border-ok/30 bg-ink-900 px-3 py-2 text-[12px] text-fg-muted">
            <Link
              to="/tickets/$id"
              params={{ id: convertedTo.ticketId }}
              className="text-signal transition-colors hover:text-signal-bright"
            >
              {t("backlog:actions.convertedLink", { number: convertedTo.ticketNumber })}
            </Link>
          </p>
        )}
        {refreshNotice && (
          <p role="status" className="font-mono text-[11px] text-fg-muted">
            {refreshNotice}
          </p>
        )}
        {item.deepDivePending && !isLocked && (
          <p className="font-mono text-[11px] text-fg-muted">
            {t("backlog:actions.deepDivePendingHint")}
          </p>
        )}
        {repos.length === 0 && !isLocked && (
          <p className="font-mono text-[11px] text-fg-faint">{t("backlog:actions.noRepos")}</p>
        )}
        {deepDiveMutation.isError && (
          <p role="alert" className="font-mono text-[11px] text-danger">
            {deepDiveMutation.error.message}
          </p>
        )}
        {convertMutation.isError && (
          <p role="alert" className="font-mono text-[11px] text-danger">
            {convertMutation.error.message}
          </p>
        )}
      </div>

      {repoDialogOpen && (
        <RepoChoiceDialog
          repos={repos}
          pending={deepDiveMutation.isPending}
          onPick={(repositoryId) => deepDiveMutation.mutate(repositoryId)}
          onClose={() => setRepoDialogOpen(false)}
        />
      )}

      {convertOpen && (
        <ConfirmDialog
          title={t("backlog:actions.convertTitle")}
          body={t("backlog:actions.convertBody")}
          confirmLabel={t("backlog:actions.convertConfirm")}
          pending={convertMutation.isPending}
          onConfirm={() => convertMutation.mutate()}
          onClose={() => setConvertOpen(false)}
        />
      )}

      {mergeOpen && (
        <MergePicker
          item={item}
          pending={mergeMutation.isPending}
          onPick={(targetId) => mergeMutation.mutate(targetId)}
          onCancel={() => setMergeOpen(false)}
        />
      )}
    </div>
  );
}

const actionButtonClass =
  "rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";

const actionPrimaryClass =
  "rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60";

/**
 * Menu "⋯" minimale accessibile per le azioni secondarie: trigger con
 * `aria-haspopup`/`aria-expanded` e un pannello (render-prop, riceve `close`)
 * che si chiude con Escape o click fuori. Pattern focus preso da ModalShell:
 * il focus va sul pannello all'apertura così Escape (sul pannello) è attivo, e
 * torna al trigger alla chiusura.
 */
function OverflowMenu({
  label,
  children,
}: {
  label: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        className={`${actionButtonClass} px-3`}
      >
        ⋯
      </button>
      {open && (
        <div
          ref={panelRef}
          tabIndex={-1}
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
          className="absolute right-0 z-20 mt-1 flex min-w-[12rem] flex-col border border-line bg-ink-900 py-1 shadow-[0_18px_40px_-20px_rgba(0,0,0,0.9)]"
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

/** Voce del menu "⋯": bottone full-width in stile terminal. */
function MenuButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="px-3 py-2 text-left font-mono text-[12px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:bg-ink-800 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** Piccola dialog di scelta del repository per il deep dive (progetto multi-repo). */
function RepoChoiceDialog({
  repos,
  pending,
  onPick,
  onClose,
}: {
  repos: { id: string; name: string }[];
  pending: boolean;
  onPick: (repositoryId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [repositoryId, setRepositoryId] = useState(repos[0]?.id ?? "");

  return (
    <ModalShell titleId="deep-dive-title" onClose={onClose}>
      <h2 id="deep-dive-title" className="text-lg font-semibold">
        {t("backlog:actions.chooseRepo")}
      </h2>
      <p className="mt-1 text-sm text-fg-muted">{t("backlog:actions.chooseRepoHint")}</p>
      <SelectField
        id="deep-dive-repo"
        label={t("backlog:actions.chooseRepo")}
        value={repositoryId}
        onChange={(event) => setRepositoryId(event.target.value)}
        options={repos.map((repo) => ({ value: repo.id, label: repo.name }))}
      />
      <div className="mt-4 flex items-center justify-end gap-3">
        <button type="button" onClick={onClose} className={actionButtonClass}>
          {t("backlog:actions.cancel")}
        </button>
        <button
          type="button"
          disabled={pending || repositoryId === ""}
          onClick={() => onPick(repositoryId)}
          className={actionPrimaryClass}
        >
          {t("backlog:actions.start")}
        </button>
      </div>
    </ModalShell>
  );
}

/** Dialog di conferma generica (usata dalla conversione in task). */
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  pending,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ModalShell titleId="confirm-title" onClose={onClose}>
      <h2 id="confirm-title" className="text-lg font-semibold">
        {title}
      </h2>
      <p className="mt-1 text-sm text-fg-muted">{body}</p>
      <div className="mt-4 flex items-center justify-end gap-3">
        <button type="button" onClick={onClose} className={actionButtonClass}>
          {t("backlog:actions.cancel")}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={onConfirm}
          className={actionPrimaryClass}
        >
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}

/**
 * Picker di fusione: le altre voci ATTIVE del progetto (la lista di default
 * esclude converted/archived), esclusa la corrente. Se la voce ha un `similarTo`
 * quella riga è evidenziata come corrispondenza suggerita.
 */
function MergePicker({
  item,
  pending,
  onPick,
  onCancel,
}: {
  item: BacklogItemDetail;
  pending: boolean;
  onPick: (targetId: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { data: candidates = [] } = useQuery({
    queryKey: [...backlogKeys.lists(), "merge-candidates", item.projectId],
    queryFn: () => listBacklogItems({ projectId: item.projectId }, undefined, 100),
    select: (page) => page.items.filter((candidate) => candidate.id !== item.id),
  });

  return (
    <ModalShell titleId="merge-title" onClose={onCancel}>
      <h2 id="merge-title" className="text-lg font-semibold">
        {t("backlog:actions.merge")}
      </h2>
      <p className="mt-1 mb-3 text-sm text-fg-muted">{t("backlog:actions.mergeHint")}</p>
      <ComboboxPicker<BacklogItem>
        items={candidates}
        getKey={(candidate) => candidate.id}
        matches={(candidate, query) => candidate.title.toLowerCase().includes(query)}
        isDisabled={() => false}
        renderOption={(candidate) => (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{candidate.title}</span>
            {item.similarTo?.id === candidate.id && (
              <span className="shrink-0 font-mono text-[10px] tracking-[0.08em] text-signal uppercase">
                {t("backlog:actions.mergeSimilar")}
              </span>
            )}
          </span>
        )}
        onPick={(candidate) => onPick(candidate.id)}
        pending={pending}
        pendingLabel={t("backlog:actions.merging")}
        onCancel={onCancel}
        labels={{
          pickerLabel: t("backlog:actions.mergePickerLabel"),
          placeholder: t("backlog:actions.mergePlaceholder"),
          noResults: t("backlog:actions.mergeNoResults"),
          cancel: t("backlog:actions.cancel"),
          moreResults: (count) => t("backlog:actions.mergeMore", { count }),
        }}
      />
    </ModalShell>
  );
}

/** Guscio modale riusabile: overlay + Escape + click fuori per chiudere. */
function ModalShell({
  titleId,
  onClose,
  children,
}: {
  titleId: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  // Focus programmatico sul pannello all'apertura (pattern Drawer): l'handler
  // Escape vive sull'overlay via onKeyDown, quindi senza spostare il focus dal
  // bottone che ha aperto la dialog Escape resterebbe inerte.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink-950/80 p-3 backdrop-blur-[2px] sm:p-6"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md border border-line bg-ink-900 p-5 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)]"
      >
        {children}
      </div>
    </div>
  );
}
