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
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BACKLOG_RISK_LABEL_KEYS,
  BACKLOG_STATUS_LABEL_KEYS,
  BacklogEffortBadge,
  BacklogRiskBadge,
  BacklogStatusBadge,
  PRIORITY_LABEL_KEYS,
  PriorityBadge,
  SOURCE_LABEL_KEYS,
} from "../../components/badges";
import { ComboboxPicker } from "../../components/combobox-picker";
import { SelectField } from "../../components/field";
import { Markdown } from "../../components/markdown";
import {
  acceptSuggested,
  ApiError,
  convertBacklogItem,
  dismissSuggested,
  mergeBacklogItem,
  patchBacklogItem,
  refreshBacklogDocument,
  requestDeepDive,
  type BacklogItem,
  type BacklogItemBase,
  type BacklogItemDetail,
  type BacklogSuggested,
} from "../../lib/api";
import { meQueryOptions } from "../../lib/auth";
import { formatDateTime } from "../../lib/format";
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
 * Dettaglio di una voce del backlog di discovery. Colonna principale: documento
 * markdown, banner dei metadati suggeriti dall'AI, avviso di analisi in corso e
 * ticket collegati. Colonna laterale: metadati editabili, barra azioni (solo
 * admin) e la chat di raffinamento. Il loader ha precaricato voce e progetti.
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

  return (
    <div className="page">
      <Link
        to="/backlog"
        className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
      >
        {t("backlog:detail.back")}
      </Link>

      <header className="mt-3 border-b border-line pb-5">
        <h1 className="text-xl font-semibold">{item.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <BacklogStatusBadge status={item.status} />
          {item.effort !== null && <BacklogEffortBadge effort={item.effort} />}
          {item.risk !== null && <BacklogRiskBadge risk={item.risk} />}
          {item.urgency !== null && <PriorityBadge priority={item.urgency} />}
          <span className="font-mono text-[11px] text-fg-faint" title={t(SOURCE_LABEL_KEYS.manual)}>
            ◇ {t(item.source === "ticket" ? "badges:source.webhook" : "badges:source.manual")}
          </span>
          <span className="font-mono text-[11px] text-fg-muted">{projectName}</span>
          {item.requestCount > 1 && (
            <span
              className="font-mono text-[11px] text-signal"
              aria-label={t("backlog:card.requestCount", { count: item.requestCount })}
            >
              ×{item.requestCount}
            </span>
          )}
        </div>
      </header>

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-6">
          {isAdmin && !isLocked && item.suggested && (
            <SuggestedBanner item={item} onApply={applyBase} />
          )}

          {item.deepDivePending && (
            <div
              role="status"
              className="rounded-sm border border-signal-dim/40 bg-ink-900 px-4 py-3 text-sm text-fg-muted"
            >
              {t("backlog:detail.deepDivePending")}
            </div>
          )}

          <section aria-label={t("backlog:detail.document")}>
            <h2 className={sectionTitleClass}>{t("backlog:detail.document")}</h2>
            {item.document.trim() === "" ? (
              <p className="font-mono text-[12px] text-fg-faint">{t("backlog:detail.noDocument")}</p>
            ) : (
              <Markdown source={item.document} />
            )}
          </section>

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

        <aside className="space-y-6 lg:border-l lg:border-line lg:pl-6">
          <div className="space-y-5">
            <h2 className={sectionTitleClass}>{t("backlog:detail.metadata")}</h2>

            {isLocked && (
              <p className="rounded-sm border border-line-strong bg-ink-900 px-3 py-2 font-mono text-[11px] text-fg-muted">
                {t("backlog:detail.lockedNotice", {
                  status: t(BACKLOG_STATUS_LABEL_KEYS[item.status]),
                })}
              </p>
            )}

            <SelectField
              id="backlog-status"
              label={t("backlog:detail.status")}
              value={EDITABLE_STATUSES.includes(item.status) ? item.status : ""}
              disabled={isLocked || patchMutation.isPending}
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

            <SelectField
              id="backlog-effort"
              label={t("backlog:detail.effort")}
              value={item.effort === null ? "" : String(item.effort)}
              disabled={isLocked || patchMutation.isPending}
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

            <SelectField
              id="backlog-risk"
              label={t("backlog:detail.risk")}
              value={item.risk ?? ""}
              disabled={isLocked || patchMutation.isPending}
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

            <SelectField
              id="backlog-urgency"
              label={t("backlog:detail.urgency")}
              value={item.urgency ?? ""}
              disabled={isLocked || patchMutation.isPending}
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
              disabled={isLocked || patchMutation.isPending}
              onCommit={(riskNote) => patchMutation.mutate({ riskNote: riskNote || null })}
            />

            {patchMutation.isError && (
              <p role="alert" className="font-mono text-[12px] text-danger">
                {patchMutation.error.message}
              </p>
            )}

            <dl className="space-y-1.5 border-t border-line pt-4">
              <MetaRow label={t("backlog:detail.createdAt")} value={formatDateTime(item.createdAt)} />
              <MetaRow label={t("backlog:detail.updatedAt")} value={formatDateTime(item.updatedAt)} />
              <MetaRow label={t("backlog:detail.requestCount")} value={String(item.requestCount)} />
            </dl>
          </div>

          {isAdmin && <ActionsPanel item={item} onApply={applyBase} navigate={navigate} />}
        </aside>
      </div>
    </div>
  );
}

/** Nota sul rischio: textarea che invia la PATCH al blur (se cambiata). */
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
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor="backlog-risk-note"
        className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
      >
        {t("backlog:detail.riskNote")}
      </label>
      <textarea
        id="backlog-risk-note"
        rows={3}
        value={draft}
        disabled={disabled}
        placeholder={t("backlog:detail.riskNotePlaceholder")}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next !== value.trim()) onCommit(next);
        }}
        className="resize-none rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 text-[13px] text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim disabled:cursor-not-allowed disabled:opacity-50"
      />
    </div>
  );
}

/** Riga di metadati chiave/valore, gemella di quella del dettaglio ticket. */
function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="font-mono text-[11px] tracking-[0.1em] text-fg-faint uppercase">{label}</dt>
      <dd className="font-mono text-[12px] text-fg-muted">{value}</dd>
    </div>
  );
}

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
  onApply,
  navigate,
}: {
  item: BacklogItemDetail;
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
    const front = [
      "---",
      `title: ${item.title}`,
      `effort: ${item.effort ?? "-"}`,
      `risk: ${item.risk ?? "-"}`,
      `urgency: ${item.urgency ?? "-"}`,
      `originTickets: ${originTickets || "-"}`,
      "---",
      "",
    ].join("\n");
    return `${front}${item.document}`;
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
    <div className="space-y-3 border-t border-line pt-5">
      <h2 className={sectionTitleClass}>{t("backlog:actions.title")}</h2>

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

      <div className="flex flex-col gap-2">
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
            {refreshNotice && (
              <p role="status" className="font-mono text-[11px] text-fg-muted">
                {refreshNotice}
              </p>
            )}

            <button
              type="button"
              disabled={deepDiveMutation.isPending || item.deepDivePending || repos.length === 0}
              onClick={startDeepDive}
              className={actionButtonClass}
            >
              {t("backlog:actions.deepDive")}
            </button>
            {item.deepDivePending && (
              <p className="font-mono text-[11px] text-fg-muted">
                {t("backlog:actions.deepDivePendingHint")}
              </p>
            )}
            {repos.length === 0 && (
              <p className="font-mono text-[11px] text-fg-faint">{t("backlog:actions.noRepos")}</p>
            )}
            {deepDiveMutation.isError && (
              <p role="alert" className="font-mono text-[11px] text-danger">
                {deepDiveMutation.error.message}
              </p>
            )}
          </>
        )}

        {/* Export: sempre disponibile, anche su voci bloccate (sola lettura). */}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void copyMarkdown()} className={actionButtonClass}>
            {copied ? t("backlog:actions.copied") : t("backlog:actions.copyMd")}
          </button>
          <button type="button" onClick={downloadMarkdown} className={actionButtonClass}>
            {t("backlog:actions.downloadMd")}
          </button>
        </div>

        {!isLocked && (
          <>
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
            {convertMutation.isError && (
              <p role="alert" className="font-mono text-[11px] text-danger">
                {convertMutation.error.message}
              </p>
            )}

            <button type="button" onClick={() => setMergeOpen(true)} className={actionButtonClass}>
              {t("backlog:actions.merge")}
            </button>

            <button
              type="button"
              disabled={statusMutation.isPending}
              onClick={() => statusMutation.mutate("archived")}
              className={actionButtonClass}
            >
              {t("backlog:actions.archive")}
            </button>
          </>
        )}

        {isArchived && (
          <button
            type="button"
            disabled={statusMutation.isPending}
            onClick={() => statusMutation.mutate("refining")}
            className={actionButtonClass}
          >
            {t("backlog:actions.reopen")}
          </button>
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
