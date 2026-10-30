import { AI_MODEL_ALIASES, AI_MODEL_IDS, type AiModelChoice } from "@stubwise/shared";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useModels, useSetModel, type ModelRow } from "../../../data/queries";
import { ErrorLine } from "../../entry/parts";
import { ReadError, refusalOf, useFlash } from "../../preferences/parts";
import { selectClass } from "../../automations/builder/controls";
import { AiSkeleton, ReadOnlyLine, useAiRefusalWords } from "./parts";

// Models (shape admin-ai.md «Models»): quale modello fa ogni tipo di
// lavoro, per gruppo (senza le operazioni tecniche), con la FONTE del valore
// sotto il nome: impostato qui, dalla configurazione del server, o il
// predefinito. Si salva alla scelta [AI 5] («Saved» per 2 s); «Use default»
// torna alla fonte di prima. Il primo valore del menu è proprio quel ritorno
// (`fallback` del livello dati): «Default (Sonnet)» o «Server configuration
// (Haiku)».

/** Il valore del menu che vuol dire «nessuna impostazione». */
const FALLBACK = "";

export function ModelsPanel({ canWrite }: { canWrite: boolean }) {
  const { t } = useTranslation();
  const models = useModels();
  return (
    <>
      <p className="max-w-[62ch] text-md text-pretty text-ink">{t("admin.ai.models.intro")}</p>
      {!canWrite && (
        <div className="mt-3">
          <ReadOnlyLine scope="settings" />
        </div>
      )}
      {models.isPending ? (
        <AiSkeleton rows={7} height={44} />
      ) : models.isError ? (
        <ReadError message={t("admin.ai.models.loadError")} onRetry={() => void models.refetch()} />
      ) : (
        groupsOf(models.data).map(([group, rows]) => (
          <ModelGroup key={group} group={group} rows={rows} canWrite={canWrite} />
        ))
      )}
    </>
  );
}

function groupsOf(rows: ModelRow[]): [ModelRow["group"], ModelRow[]][] {
  const out = new Map<ModelRow["group"], ModelRow[]>();
  for (const r of rows) out.set(r.group, [...(out.get(r.group) ?? []), r]);
  return [...out];
}

function ModelGroup({
  group,
  rows,
  canWrite,
}: {
  group: ModelRow["group"];
  rows: ModelRow[];
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-6">
      <h2 id={id} className="heading-group pb-1.5">
        {t(`admin.ai.models.groups.${group}`)}
      </h2>
      <ul aria-labelledby={id} className="@container border-t border-rule">
        {rows.map((row) => (
          <ModelLine key={row.operation} row={row} canWrite={canWrite} />
        ))}
      </ul>
    </section>
  );
}

/** Il nome di un modello: l'alias in parola («Opus»), un id così com'è. */
function useModelWords() {
  const { t } = useTranslation();
  return (model: AiModelChoice) =>
    (AI_MODEL_ALIASES as readonly string[]).includes(model)
      ? t(`admin.ai.models.aliases.${model}`)
      : model;
}

/**
 * Un'operazione (44 px): il nome e sotto la fonte, a destra il menu del
 * modello (200 px). Stretto, il menu scende sotto il nome.
 */
function ModelLine({ row, canWrite }: { row: ModelRow; canWrite: boolean }) {
  const { t } = useTranslation();
  const setModel = useSetModel();
  const modelWords = useModelWords();
  const refusalWords = useAiRefusalWords();
  const [saved, flash] = useFlash();
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const selectId = useId();
  const name = t(`usage.operations.${row.operation}`);

  async function choose(model: AiModelChoice | null) {
    setError(null);
    const result = await setModel.mutateAsync([row.operation, model]).catch(() => null);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal) return setError(refusalWords(refusal.error));
    flash();
  }

  return (
    <li
      role="group"
      aria-labelledby={nameId}
      className="flex min-h-11 flex-col gap-1 border-b border-rule py-1.5"
    >
      <div className="flex flex-col gap-2 @min-[720px]:flex-row @min-[720px]:items-center @min-[720px]:gap-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <span id={nameId} className="text-md text-ink">
            {name}
          </span>
          <span className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-muted">
            <span>{t(`admin.ai.models.source.${row.source}`)}</span>
            {row.source === "setting" && canWrite && (
              <button
                type="button"
                onClick={() => void choose(null)}
                className="rounded-sm font-medium text-ink underline-offset-2 hover:underline"
              >
                {t("admin.ai.models.useDefault")}
              </button>
            )}
          </span>
        </div>
        <span className="flex shrink-0 flex-row-reverse items-center justify-end gap-2 @min-[720px]:flex-row">
          <span aria-live="polite" className="text-xs text-ink-muted @min-[720px]:w-12 @min-[720px]:text-right">
            {saved ? t("admin.ai.saved") : ""}
          </span>
          <label htmlFor={selectId} className="sr-only">
            {t("admin.ai.models.modelFor", { operation: name })}
          </label>
          <select
            id={selectId}
            value={row.source === "setting" ? row.model : FALLBACK}
            disabled={!canWrite}
            onChange={(e) => void choose((e.target.value || null) as AiModelChoice | null)}
            className={`${selectClass} w-[220px] @min-[720px]:w-[200px] disabled:cursor-not-allowed`}
          >
            <option value={FALLBACK}>
              {t(`admin.ai.models.fallback.${row.fallback.source}`, {
                model: modelWords(row.fallback.model),
              })}
            </option>
            {AI_MODEL_ALIASES.map((m) => (
              <option key={m} value={m}>
                {modelWords(m)}
              </option>
            ))}
            <optgroup label={t("admin.ai.models.versions")}>
              {AI_MODEL_IDS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </optgroup>
          </select>
        </span>
      </div>
      {error && <ErrorLine>{error}</ErrorLine>}
    </li>
  );
}
