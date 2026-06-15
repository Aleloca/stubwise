import { EFFORT_LABELS, ticketTypeSchema, type TicketType } from "@stubwise/shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { TypeBadge } from "../../components/badges";
import { putAutomationSettings, type AutomationRule } from "../../lib/api";
import { automationSettingsQueryOptions } from "../../lib/queries";

/** Etichetta "Medio (3/5)" per un valore di sforzo. */
function effortOptionLabel(value: number): string {
  return `${EFFORT_LABELS[value] ?? value} (${value}/5)`;
}

/**
 * Sotto-pagina Automazione AI (solo admin): una riga per ciascuno dei 4 tipi di
 * ticket con il toggle auto-fix e la soglia di sforzo. Un solo Save persiste
 * tutte le regole via PUT; lo stato locale parte dai dati del server.
 */
export function SettingsAutomationPage() {
  const queryClient = useQueryClient();
  const { data: settings } = useSuspenseQuery(automationSettingsQueryOptions);

  // Stato locale modificabile: inizializzato dai dati del server e risincro-
  // nizzato quando questi cambiano (es. dopo un salvataggio o un refetch).
  const [rules, setRules] = useState<AutomationRule[]>(settings.rules);
  useEffect(() => {
    setRules(settings.rules);
  }, [settings.rules]);

  const mutation = useMutation({
    mutationFn: (next: AutomationRule[]) => putAutomationSettings(next),
    onSuccess: (updated) => {
      queryClient.setQueryData(automationSettingsQueryOptions.queryKey, updated);
    },
  });

  // Ordine stabile dei tipi (l'enum), a prescindere dall'ordine del server.
  const byType = new Map(rules.map((r) => [r.type, r]));
  const orderedTypes = ticketTypeSchema.options as readonly TicketType[];

  const updateRule = (type: TicketType, patch: Partial<AutomationRule>): void => {
    setRules((current) => current.map((r) => (r.type === type ? { ...r, ...patch } : r)));
    // Un salvataggio andato a buon fine va "consumato": la riga di conferma
    // sparisce appena l'utente ritocca qualcosa.
    if (mutation.isSuccess) mutation.reset();
  };

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          Automazione AI
        </h2>
        <p className="mt-1 font-mono text-[11px] text-fg-faint">
          Il fix automatico parte solo se l'auto-fix è attivo e l'effort stimato è entro la soglia.
        </p>
        <a
          href="/docs/ai-pipeline/automation/"
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block font-mono text-[11px] text-signal underline-offset-2 hover:underline"
        >
          Vedi documentazione →
        </a>
      </header>

      <div className="divide-y divide-line">
        {orderedTypes.map((type) => {
          const rule = byType.get(type);
          if (!rule) return null;
          return (
            <div key={type} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
              <div className="w-24">
                <TypeBadge type={type} />
              </div>

              <label className="flex items-center gap-2 font-mono text-[12px] text-fg-muted">
                <input
                  type="checkbox"
                  checked={rule.autoFix}
                  disabled={mutation.isPending}
                  onChange={(event) => updateRule(type, { autoFix: event.target.checked })}
                  className="size-4 accent-signal"
                  aria-label={`Auto-fix ${type}`}
                />
                Auto-fix
              </label>

              <label className="flex items-center gap-2 font-mono text-[12px] text-fg-muted">
                <span className="text-fg-faint">Soglia</span>
                <select
                  value={rule.maxEffort}
                  disabled={mutation.isPending}
                  onChange={(event) => updateRule(type, { maxEffort: Number(event.target.value) })}
                  aria-label={`Soglia effort ${type}`}
                  className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
                >
                  {[1, 2, 3, 4, 5].map((value) => (
                    <option key={value} value={value}>
                      {effortOptionLabel(value)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex items-center gap-2 font-mono text-[12px] text-fg-muted">
                <span className="text-fg-faint">Approvazione piano da effort ≥</span>
                <select
                  value={rule.planApprovalMinEffort ?? ""}
                  disabled={mutation.isPending}
                  onChange={(event) =>
                    updateRule(type, {
                      planApprovalMinEffort:
                        event.target.value === "" ? null : Number(event.target.value),
                    })
                  }
                  aria-label={`Approvazione piano ${type}`}
                  className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
                >
                  <option value="">Mai</option>
                  {[1, 2, 3, 4, 5].map((value) => (
                    <option key={value} value={value}>
                      {effortOptionLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          );
        })}
      </div>

      <footer className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
        <button
          type="button"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate(rules)}
          className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim"
        >
          {mutation.isPending ? "Salvataggio…" : "Salva"}
        </button>
        {mutation.isSuccess && (
          <span role="status" className="font-mono text-[12px] text-ok">
            Salvato
          </span>
        )}
        {mutation.isError && (
          <span role="alert" className="font-mono text-[12px] text-danger">
            {mutation.error.message}
          </span>
        )}
      </footer>
    </section>
  );
}
