import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { usePeople } from "../../data/queries";
import type { ConversationEvent, ModelUsage, RunProvider } from "../../data/types";
import type { PrCycle, PrLine } from "../../domain/claude/taskWork";
import { GeneratedTag } from "../overview/BriefCard";
import { formatDate } from "../../notifications/time";
import { ActionRow } from "../claude/conversation/ActionRows";
import { DisclosureGlyph } from "../claude/conversation/parts";
import { ghostButton } from "./parts";
import { phaseName, providerLabel } from "./WorkStory";

// I pezzi della sezione «Claude» che vengono dall'«AI activity» e dal
// pannello dei consumi del web: con chi gira la sessione, il riassunto di un
// fallimento con il suo log, le PR con lo stato del ciclo review →
// correzione, i consumi per modello.

const K = "taskDetail.claude";

/** «claude-haiku-5-5» → «Haiku»: la famiglia del modello; un id d'altra forma resta com'è. */
export function modelName(model: string): string {
  const m = /^claude-([a-z]+)-/.exec(model);
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)}` : model;
}

/**
 * Sotto la riga di stato: con chi gira la sessione, per nome. Le sessioni
 * nate dall'area 9b dicono anche il modello con cui sono partite (shape
 * instance-effects [EF 3]): «Model: Haiku · Account: Backup Max
 * (subscription)»; un cambio successivo in Models non le riscrive.
 */
export function ProviderLine({
  provider,
  model = null,
}: {
  provider: RunProvider | null;
  model?: string | null;
}) {
  const { t } = useTranslation();
  if (model === null) {
    if (!provider) return null;
    return (
      <p data-run-provider className="-mt-2 pl-[34px] text-xs text-ink-faint">
        {t(`${K}.provider.label`, { provider: providerLabel(t, provider) })}
      </p>
    );
  }
  const account = provider
    ? t(`instanceEffects.run.${provider.kind === "account" ? "subscription" : "api_key"}`, {
        name: provider.name,
      })
    : t("instanceEffects.run.noAccount");
  return (
    <p data-run-provider className="-mt-2 pl-[34px] text-xs text-ink-faint">
      {t("instanceEffects.run.line", { model: modelName(model), account })}
    </p>
  );
}

/**
 * Una sessione fallita o scaduta: il riassunto del fallimento in una riga e
 * «Show log», che apre qui le azioni della fase in cui è finita (le stesse
 * righe della conversazione, con ingresso e risultato).
 */
export function FailureBlock({
  summary,
  phase,
  events,
}: {
  summary: string;
  phase: string | null;
  events: readonly ConversationEvent[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const logId = useId();
  const actions = lastPhaseActions(events);
  const label = t(`${K}.failure.logLabel`, { phase: phaseName(t, phase) });
  return (
    <div data-run-failure className="flex flex-col gap-1">
      {/* Il riassunto lo scrive l'AI: si dice, come «In brief» del web. */}
      <p className="flex items-center gap-2 text-xs text-ink-muted">
        <span className="font-medium">{t(`${K}.failure.label`)}</span>
        <GeneratedTag />
      </p>
      <p className="text-sm text-ink [overflow-wrap:anywhere]">{summary}</p>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={logId}
        onClick={() => setOpen((o) => !o)}
        className={`${ghostButton} -ml-2 self-start`}
      >
        <DisclosureGlyph open={open} />
        {open ? t(`${K}.failure.hideLog`) : t(`${K}.failure.showLog`)}
      </button>
      {open &&
        (actions.length > 0 ? (
          <ul id={logId} aria-label={label} className="event-enter flex min-w-0 flex-col">
            {actions.map((a) => (
              <ActionRow key={a.id} action={a} />
            ))}
          </ul>
        ) : (
          <p id={logId} className="text-sm text-ink-muted">
            {t(`${K}.failure.noLog`)}
          </p>
        ))}
    </div>
  );
}

type Action = Extract<ConversationEvent, { type: "action" }>;

/** Le azioni dell'ultima fase aperta del flusso (quella in cui la sessione è finita). */
export function lastPhaseActions(events: readonly ConversationEvent[]): Action[] {
  let start = 0;
  events.forEach((e, i) => {
    if (e.type === "phase" && e.outcome === null) start = i + 1;
  });
  return events.slice(start).filter((e): e is Action => e.type === "action");
}

/** La riga del ciclo di una PR, nelle parole di oggi (`pr-cycle-row` del web). */
function cycleText(t: TFunction, cycle: PrCycle, name: (id: string | null) => string): string {
  switch (cycle.state) {
    case "correcting":
    case "paused":
      return t(`${K}.cycle.${cycle.state}`, { round: cycle.round, max: cycle.maxRounds });
    case "capped":
      return t(`${K}.cycle.capped`, { count: cycle.round });
    case "changes_requested":
      if (cycle.requestedById && cycle.requestedOn) {
        return t(
          `${K}.cycle.${cycle.requestedOn === "stubwise" ? "changesRequestedStubwise" : "changesRequestedPlatform"}`,
          { name: name(cycle.requestedById) },
        );
      }
      return t(`${K}.cycle.changes_requested`);
    default:
      return t(`${K}.cycle.${cycle.state}`);
  }
}

/** Il tono della riga del ciclo: colore solo dove dice qualcosa (fermo al tetto, fallito). */
const CYCLE_TONE: Partial<Record<PrCycle["state"], string>> = {
  capped: "text-warning",
  correction_failed: "text-critical",
};

/**
 * Le PR della task, una riga per repository: numero (link esterno),
 * repository e stato; sotto, quando il «server» lo conosce, lo stato del
 * ciclo review → correzione e il blocco di un branch protetto. Con PR su più
 * repository, in testa «N repos».
 */
export function PrRows({ prs, cycles }: { prs: PrLine[]; cycles: ReadonlyMap<string, PrCycle> }) {
  const { t, i18n } = useTranslation();
  const people = usePeople().data;
  const name = (id: string | null) => people?.find((p) => p.id === id)?.name ?? "";
  const repos = new Set(prs.map((p) => p.repo).filter((r): r is string => r !== null));
  return (
    <>
      {repos.size > 1 && (
        <li className="flex min-h-7 items-center">
          <span
            data-repo-count
            className="num text-xs font-semibold tracking-[0.02em] text-ink-muted"
          >
            {t(`${K}.repos`, { count: repos.size })}
          </span>
        </li>
      )}
      {prs.map((pr) => {
        const cycle = cycles.get(pr.key);
        const label = pr.number !== null ? t(`${K}.pr.number`, { n: pr.number }) : pr.text;
        return (
          <li
            key={pr.key}
            data-pr={pr.number ?? undefined}
            className="flex flex-col py-1 text-sm"
          >
            <span className="flex min-h-6 min-w-0 items-center gap-1.5">
              {pr.link ? (
                <a
                  href={pr.link}
                  target="_blank"
                  rel="noreferrer"
                  className="num font-semibold text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink"
                >
                  {label}
                </a>
              ) : (
                <span className="num font-semibold text-ink">{label}</span>
              )}
              {pr.repo && (
                <>
                  <span aria-hidden="true" className="text-ink-faint">
                    ·
                  </span>
                  <span className="min-w-0 truncate text-ink-muted">{pr.repo}</span>
                </>
              )}
              <span aria-hidden="true" className="text-ink-faint">
                ·
              </span>
              <span className="shrink-0 text-ink-muted">
                {pr.state === "open"
                  ? t(`${K}.pr.open`)
                  : t(`${K}.pr.${pr.state}`, { date: formatDate(pr.closedAt!, i18n.language) })}
              </span>
            </span>
            {cycle && pr.state === "open" && (
              <span
                data-pr-cycle={cycle.state}
                className={`min-w-0 [overflow-wrap:anywhere] ${CYCLE_TONE[cycle.state] ?? "text-ink-muted"}`}
              >
                {cycleText(t, cycle, name)}
              </span>
            )}
            {cycle?.branchProtected && pr.state === "open" && (
              <span
                data-pr-blocked
                className="min-w-0 font-medium text-warning [overflow-wrap:anywhere]"
              >
                {t(`${K}.cycle.blocked`)}
              </span>
            )}
          </li>
        );
      })}
    </>
  );
}

/** Token in forma breve («240.8K»), nella lingua di chi guarda. */
function tokens(n: number, language: string): string {
  return new Intl.NumberFormat(language, { notation: "compact", maximumFractionDigits: 1 }).format(
    n,
  );
}

function usd(n: number, language: string): string {
  return new Intl.NumberFormat(language, { style: "currency", currency: "USD" }).format(n);
}

/**
 * I consumi AI della task: chiusi, una riga con token e costo totali;
 * aperti, una riga per modello con ingresso, uscita, cache e costo.
 */
export function UsageDisclosure({ usage }: { usage: ModelUsage[] }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (usage.length === 0) return null;
  const lang = i18n.language;
  const total = usage.reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0);
  const cost = Math.round(usage.reduce((sum, u) => sum + u.costUsd, 0) * 100) / 100;
  const title = t(`${K}.usage.title`);
  return (
    <div data-ai-usage className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className="-ml-1.5 flex h-8 items-center gap-1.5 self-start rounded-md px-1.5 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
      >
        <DisclosureGlyph open={open} />
        {title}
        <span className="num text-xs font-normal text-ink-faint">
          {t(`${K}.usage.summary`, { tokens: tokens(total, lang), cost: usd(cost, lang) })}
        </span>
      </button>
      {open && (
        <ul
          id={listId}
          aria-label={t(`${K}.usage.listLabel`)}
          className="event-enter mt-1 flex flex-col border-l border-rule pl-3"
        >
          {usage.map((u) => (
            <li key={u.model} className="flex flex-col py-1 text-sm">
              <span className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1 truncate text-ink" title={u.model}>
                  {u.model}
                </span>
                <span className="num shrink-0 text-ink">{usd(u.costUsd, lang)}</span>
              </span>
              <span className="num text-xs text-ink-muted">
                {t(`${K}.usage.detail`, {
                  input: tokens(u.inputTokens, lang),
                  output: tokens(u.outputTokens, lang),
                  cache: tokens(u.cacheReadTokens, lang),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
