import { AI_OPERATION_GROUPS, type AiModelChoice, type AiOperation } from "@stubwise/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { patchModelSettings } from "../lib/api";
import { modelSettingsQueryOptions } from "../lib/queries";

/**
 * Sezione «Modelli» di Automazione (solo admin): il modello Anthropic per ogni
 * tipo di lavoro AI. Salvataggio proprio, indipendente da quello delle regole:
 * sono due endpoint distinti. Invia solo le righe cambiate (valore = imposta,
 * null = torna al predefinito). Le operazioni tecniche non si mostrano.
 */
export function ModelSettingsSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, isError, error } = useQuery(modelSettingsQueryOptions);
  // Solo le modifiche non ancora salvate: operazione → scelta (null = predefinito).
  const [draft, setDraft] = useState<Partial<Record<AiOperation, AiModelChoice | null>>>({});

  const mutation = useMutation({
    mutationFn: patchModelSettings,
    onSuccess: (updated) => {
      queryClient.setQueryData(modelSettingsQueryOptions.queryKey, updated);
      setDraft({});
    },
  });

  // Difesa nel punto di lettura: il web non parsa le risposte.
  const operations = data?.operations ?? [];
  const choices = data?.choices ?? [];
  const byOperation = new Map(operations.map((o) => [o.operation, o]));
  const dirty = Object.keys(draft).length > 0;

  const change = (operation: AiOperation, saved: AiModelChoice | null, raw: string): void => {
    const value = raw === "" ? null : (raw as AiModelChoice);
    setDraft((current) => {
      const next = { ...current };
      if (value === saved) delete next[operation];
      else next[operation] = value;
      return next;
    });
    if (mutation.isSuccess) mutation.reset();
  };

  return (
    <section className="border-t border-line">
      <header className="px-4 py-3">
        <h3 className="font-mono text-[12px] font-medium tracking-[0.12em] text-fg-muted uppercase">
          {t("automation:models.title")}
        </h3>
        <p className="mt-1 font-mono text-[11px] text-fg-faint">
          {t("automation:models.subtitle")}
        </p>
      </header>

      {isError && (
        <p role="alert" className="px-4 pb-3 font-mono text-[12px] text-danger">
          {error.message}
        </p>
      )}

      {AI_OPERATION_GROUPS.filter((g) => g.group !== "technical").map(
        ({ group, operations: ops }) => {
          const rows = ops.map((op) => byOperation.get(op)).filter((r) => r?.configurable);
          if (rows.length === 0) return null;
          return (
            <div key={group} className="border-t border-line">
              <h4 className="px-4 pt-3 font-mono text-[11px] tracking-[0.1em] text-fg-faint uppercase">
                {t(`automation:models.groups.${group}`)}
              </h4>
              <div className="divide-y divide-line">
                {rows.map((row) => {
                  if (!row) return null;
                  const op = row.operation;
                  const saved = row.model ?? null;
                  const current = op in draft ? (draft[op] ?? null) : saved;
                  const label = t(`automation:models.ops.${op}`);
                  return (
                    <div key={op} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
                      <label
                        htmlFor={`model-${op}`}
                        className="w-64 font-mono text-[12px] text-fg-muted"
                      >
                        {label}
                      </label>
                      <select
                        id={`model-${op}`}
                        aria-label={label}
                        value={current ?? ""}
                        disabled={mutation.isPending}
                        onChange={(event) => change(op, saved, event.target.value)}
                        className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
                      >
                        <option value="">{t("automation:models.default")}</option>
                        {choices.map((choice) => (
                          <option key={choice} value={choice}>
                            {choice}
                          </option>
                        ))}
                      </select>
                      {current === null && (
                        <span className="font-mono text-[11px] text-fg-faint">
                          {(row.workerDefault ?? null) === null
                            ? t("automation:models.workerDefault")
                            : t("automation:models.defaultIs", { model: row.workerDefault })}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        },
      )}

      <footer className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
        <button
          type="button"
          disabled={mutation.isPending || !dirty}
          onClick={() => mutation.mutate(draft)}
          className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim"
        >
          {mutation.isPending ? t("automation:saving") : t("automation:models.save")}
        </button>
        {mutation.isSuccess && (
          <span role="status" className="font-mono text-[12px] text-ok">
            {t("automation:saved")}
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
