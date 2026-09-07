import { useState } from "react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { createProjectDecision, patchProjectDecision } from "../../lib/api";
import type { DecisionSource, ProjectDecision } from "../../lib/api";
import { formatDate } from "../../lib/format";
import { projectDecisionsQueryOptions, projectQueryOptions } from "../../lib/queries";

const route = getRouteApi("/authed/docs/project/$projectId/decisions");

/**
 * IL REGISTRO DECISIONI di un progetto (Fase 5).
 *
 * Sta nei Docs e non fra le pagine generate perché una decisione NON è una
 * `doc_page`: le pagine non conoscono i progetti, non hanno un attore
 * strutturato e vengono riscritte a ogni generazione — mentre il senso del
 * registro è esattamente che nessuno lo riscrive.
 *
 * ⚠️ Le voci automatiche (risposta a una domanda, piano approvato o rifiutato
 * con indicazioni, proposta del pulse accettata) le scrive il server DA
 * TEMPLATE, mai un agente. Qui si aggiungono le voci a mano e si corregge —
 * o si segna come superata — la propria.
 */

/** Le sorgenti filtrabili, nell'ordine in cui hanno senso da leggere. */
const SOURCES = ["ask_user", "plan_review", "pulse", "manual"] as const;

export function ProjectDecisionsPage() {
  const { t } = useTranslation();
  const { projectId } = route.useParams();
  const queryClient = useQueryClient();

  const { data: project } = useSuspenseQuery(projectQueryOptions(projectId));
  const [source, setSource] = useState<DecisionSource | undefined>(undefined);
  const {
    data: decisions,
    isPending,
    isError,
  } = useQuery(projectDecisionsQueryOptions(project.id, source));

  const [title, setTitle] = useState("");
  const [decision, setDecision] = useState("");
  const [context, setContext] = useState("");

  /** Invalida l'INTERO sottoalbero delle decisioni: i filtri sono chiavi diverse. */
  function invalidate() {
    return queryClient.invalidateQueries({
      queryKey: ["projects", "detail", project.id, "decisions"],
    });
  }

  const create = useMutation({
    mutationFn: () =>
      createProjectDecision(project.id, {
        title: title.trim(),
        decision: decision.trim(),
        ...(context.trim() ? { context: context.trim() } : {}),
      }),
    onSuccess: async () => {
      setTitle("");
      setDecision("");
      setContext("");
      await invalidate();
    },
  });

  const supersede = useMutation({
    mutationFn: (input: { id: string; supersededById: string | null }) =>
      patchProjectDecision(project.id, input.id, { supersededById: input.supersededById }),
    onSuccess: () => invalidate(),
  });

  const canSubmit = title.trim().length > 0 && decision.trim().length > 0 && !create.isPending;

  return (
    <div className="page">
      <Link
        to="/docs/project/$projectId"
        params={{ projectId: project.id }}
        className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
      >
        {t("docs:decisions.back")}
      </Link>

      <header className="mt-3 border-b border-line pb-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold">{project.name}</h1>
          <span className="font-mono text-[12px] tracking-[0.12em] text-signal uppercase">
            {t("docs:decisions.title")}
          </span>
        </div>
        <p className="mt-2 max-w-2xl text-[13px] text-fg-muted">{t("docs:decisions.subtitle")}</p>
      </header>

      <div
        role="toolbar"
        aria-label={t("docs:decisions.filters")}
        className="mt-6 flex flex-wrap gap-2"
      >
        <button
          type="button"
          aria-pressed={source === undefined}
          onClick={() => setSource(undefined)}
          className={chipClass(source === undefined)}
        >
          {t("docs:decisions.filter.all")}
        </button>
        {SOURCES.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={source === value}
            onClick={() => setSource(value)}
            className={chipClass(source === value)}
          >
            {t(`docs:decisions.source.${value}`)}
          </button>
        ))}
      </div>

      <section aria-label={t("docs:decisions.listTitle")} className="mt-6">
        {isError ? (
          <p className="font-mono text-[12px] text-danger">{t("docs:decisions.error")}</p>
        ) : isPending ? (
          <p className="font-mono text-[12px] text-fg-faint">{t("docs:decisions.loading")}</p>
        ) : decisions.length === 0 ? (
          <p className="font-mono text-[12px] text-fg-faint">{t("docs:decisions.empty")}</p>
        ) : (
          <ul>
            {decisions.map((row) => (
              <DecisionRow
                key={row.id}
                decision={row}
                onSupersede={(supersededById) => supersede.mutate({ id: row.id, supersededById })}
                busy={supersede.isPending}
                others={decisions.filter((other) => other.id !== row.id)}
              />
            ))}
          </ul>
        )}
      </section>

      <section
        aria-label={t("docs:decisions.newTitle")}
        className="mt-10 border-t border-line pt-6"
      >
        <h2 className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">
          {t("docs:decisions.newTitle")}
        </h2>
        <p className="mt-2 max-w-2xl text-[13px] text-fg-muted">{t("docs:decisions.newHint")}</p>
        <form
          className="mt-4 max-w-2xl space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) create.mutate();
          }}
        >
          <label className="block">
            <span className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
              {t("docs:decisions.field.title")}
            </span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={300}
              className="mt-1 w-full rounded-sm border border-line-strong bg-transparent px-2 py-1.5 text-[13px]"
            />
          </label>
          <label className="block">
            <span className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
              {t("docs:decisions.field.decision")}
            </span>
            <textarea
              value={decision}
              onChange={(event) => setDecision(event.target.value)}
              rows={3}
              maxLength={5000}
              className="mt-1 w-full rounded-sm border border-line-strong bg-transparent px-2 py-1.5 text-[13px]"
            />
          </label>
          <label className="block">
            <span className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
              {t("docs:decisions.field.context")}
            </span>
            <textarea
              value={context}
              onChange={(event) => setContext(event.target.value)}
              rows={2}
              maxLength={5000}
              className="mt-1 w-full rounded-sm border border-line-strong bg-transparent px-2 py-1.5 text-[13px]"
            />
          </label>
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-sm border border-signal/60 bg-signal/10 px-3 py-1.5 font-mono text-[11px] tracking-[0.08em] text-signal uppercase disabled:opacity-40"
          >
            {t("docs:decisions.submit")}
          </button>
          {create.isError && (
            <p className="font-mono text-[12px] text-danger">{t("docs:decisions.saveError")}</p>
          )}
        </form>
      </section>
    </div>
  );
}

function chipClass(active: boolean): string {
  return `rounded-sm border px-2.5 py-1 font-mono text-[11px] tracking-[0.08em] uppercase transition-colors ${
    active
      ? "border-signal/60 bg-signal/10 text-signal"
      : "border-line-strong text-fg-faint hover:border-ink-700 hover:text-fg-muted"
  }`;
}

/**
 * Una riga del registro.
 *
 * Una decisione SUPERATA non sparisce e non si cancella: si mostra attenuata e
 * marcata. È il punto del registro — sapere che una scelta è stata cambiata
 * vale quanto sapere che era stata presa.
 */
function DecisionRow({
  decision,
  others,
  onSupersede,
  busy,
}: {
  decision: ProjectDecision;
  others: ProjectDecision[];
  onSupersede: (supersededById: string | null) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const superseded = decision.supersededById !== null;

  return (
    <li className={`border-b border-line py-4 ${superseded ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[14px] font-medium">{decision.title}</h3>
        <span className="font-mono text-[10px] tracking-[0.12em] text-fg-faint uppercase">
          {t(`docs:decisions.source.${decision.source}`)}
        </span>
        {superseded && (
          <span className="font-mono text-[10px] tracking-[0.12em] text-signal-dim uppercase">
            {t("docs:decisions.superseded")}
          </span>
        )}
      </div>

      <p className="mt-1.5 text-[13px]">{decision.decision}</p>
      {decision.context && (
        <p className="mt-1 text-[12px] text-fg-muted">
          {t("docs:decisions.field.context")}: {decision.context}
        </p>
      )}
      {decision.consequences && (
        <p className="mt-1 text-[12px] text-fg-muted">
          {t("docs:decisions.field.consequences")}: {decision.consequences}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-fg-faint">
        <span>{formatDate(decision.decidedAt)}</span>
        <span>
          {decision.decidedBy
            ? t("docs:decisions.by", { email: decision.decidedBy.email })
            : t("docs:decisions.byNobody")}
        </span>
        {decision.ticketNumber !== null && (
          <Link
            to="/tickets/$id"
            params={{ id: decision.ticketId! }}
            className="text-signal hover:underline"
          >
            #{decision.ticketNumber}
          </Link>
        )}
      </div>

      {/*
        "Segna come superata" è una SELECT e non un bottone: superata da quale?
        Senza dirlo il registro perderebbe l'unica informazione che rende utile
        la marcatura. Il server rifiuta comunque una decisione di un altro
        progetto o sé stessa; qui si offrono solo le altre di questa lista.
      */}
      {others.length > 0 && (
        <label className="mt-2 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] tracking-[0.12em] text-fg-faint uppercase">
            {superseded ? t("docs:decisions.supersedeChange") : t("docs:decisions.supersedeBy")}
          </span>
          <select
            value={decision.supersededById ?? ""}
            disabled={busy}
            onChange={(event) => onSupersede(event.target.value === "" ? null : event.target.value)}
            className="rounded-sm border border-line-strong bg-transparent px-2 py-1 font-mono text-[11px]"
          >
            <option value="">{t("docs:decisions.supersedeNone")}</option>
            {others.map((other) => (
              <option key={other.id} value={other.id}>
                {other.title}
              </option>
            ))}
          </select>
        </label>
      )}
    </li>
  );
}
