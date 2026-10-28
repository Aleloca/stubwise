import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { lookup } from "../../../domain/automations/conditions";
import { triggerFields } from "../../../domain/automations/fields";
import { show } from "../../../domain/automations/preview";
import { useAutomationSimulationExamples, usePeople } from "../../../data/queries";
import type {
  AutomationFlow,
  AutomationSourceView,
  DataField,
  SimulationExample,
} from "../../../data/types";
import { Dialog, inputClass } from "../../../tasks-ui/Dialog";
import { RadioDot } from "../../../tasks-ui/Menu";
import { primaryButton, secondaryButton } from "../../tasks/controls";
import { shortDate } from "../format";

// «Choose an example» (shape automation-test §5, «Partire»): l'evento su cui
// gira la prova. «Recent events» = gli eventi d'esempio della sorgente, o le
// cose vere recenti che chi prova vede (`listSimulationExamples`); «Write
// one» = un modulo coi dati dell'inizio, precompilato dall'evento più
// recente, nessun campo obbligatorio (un dato vuoto è un caso da provare). I
// file si scelgono fra quelli degli esempi, non si caricano ([A 6]).

export interface ChosenExample {
  event: Record<string, unknown>;
  /** La riga leggibile («Deal won · Rossi Srl»), o null se scritto a mano. */
  label: string | null;
}

type Values = Record<string, unknown>;

/** Scrive `value` alla chiave puntata (`trattativa.cliente`) di un oggetto. */
function setAt(o: Values, key: string, value: unknown): Values {
  const out = structuredClone(o);
  const segs = key.split(".");
  let cur: Values = out;
  for (const s of segs.slice(0, -1)) {
    if (!cur[s] || typeof cur[s] !== "object" || Array.isArray(cur[s])) cur[s] = {};
    cur = cur[s] as Values;
  }
  cur[segs.at(-1)!] = value;
  return out;
}

/** I file finti fra cui scegliere: quelli degli esempi ([A 6]). */
function filesOf(examples: SimulationExample[], fields: DataField[]) {
  const out = new Map<string, Record<string, unknown>>();
  for (const e of examples)
    for (const f of fields)
      if (f.type === "file") {
        const v = lookup(e.event, f.key);
        if (v && typeof v === "object" && typeof (v as Values).nome === "string")
          out.set((v as Values).nome as string, v as Values);
      }
  return [...out.values()];
}

export function ExampleDialog({
  automationId,
  version,
  flow,
  sources,
  onStart,
  onClose,
  error,
}: {
  automationId: string;
  version: number | "draft";
  flow: AutomationFlow;
  sources: AutomationSourceView[];
  onStart: (example: ChosenExample) => void;
  onClose: () => void;
  /** La prova non è partita (errore del livello dati). */
  error: boolean;
}) {
  const { t, i18n } = useTranslation();
  const examples = useAutomationSimulationExamples(automationId, version);
  const list = examples.data ?? [];
  const tr = flow.trigger;
  const fields = useMemo(() => triggerFields(flow, sources), [flow, sources]);
  // Ricorrenza e avvio a mano: nessun elenco, solo il modulo.
  const formOnly = tr.kind === "schedule" || tr.kind === "manual";
  const [tab, setTab] = useState<"recent" | "write" | null>(null);
  const mode = formOnly
    ? "write"
    : (tab ?? (examples.isSuccess && list.length === 0 ? "write" : "recent"));
  const [picked, setPicked] = useState(0);
  const [values, setValues] = useState<Values | null>(null);
  const form = values ?? (list[0] ? structuredClone(list[0].event) : {});
  const sourceName =
    tr.kind === "source" ? (sources.find((s) => s.id === tr.sourceId)?.name ?? "") : "";
  const start = () => {
    if (mode === "recent") {
      const e = list[picked];
      if (e) onStart({ event: structuredClone(e.event), label: exampleLine(e, i18n.language) });
    } else onStart({ event: form, label: null });
  };
  const groupId = useId();
  return (
    <Dialog
      title={t("automations.test.example.title")}
      width={640}
      onClose={onClose}
      footer={
        <>
          {error && (
            <p role="alert" className="mr-auto text-sm text-critical">
              {t("automations.test.example.startError")}
            </p>
          )}
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            data-start-test
            className={`${primaryButton} disabled:opacity-40`}
            disabled={mode === "recent" && !list[picked]}
            onClick={start}
          >
            {t("automations.test.example.start")}
          </button>
        </>
      }
    >
      {!formOnly && (
        <div
          role="tablist"
          aria-label={t("automations.test.example.title")}
          className="flex w-fit items-center rounded-md border border-rule p-0.5"
        >
          {(["recent", "write"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={mode === k}
              onClick={() => setTab(k)}
              className={`h-7 rounded-[5px] px-3 text-sm font-medium ${mode === k ? "bg-ink/10 text-ink" : "text-ink-muted hover:text-ink"}`}
            >
              {t(`automations.test.example.${k}`)}
            </button>
          ))}
        </div>
      )}
      {mode === "recent" ? (
        examples.isPending ? (
          <p role="status" className="text-sm text-ink-muted">
            {t("automations.test.example.loading")}
          </p>
        ) : list.length === 0 ? (
          <p className="text-md text-ink-muted">
            {tr.kind === "source"
              ? t("automations.test.example.noRecent", { source: sourceName })
              : t("automations.test.example.noRecentHere")}
          </p>
        ) : (
          <div
            role="radiogroup"
            aria-labelledby={groupId}
            // Spazio per l'anello di fuoco (2px + 2px di distanza): dentro un elenco che scorre non va tagliato.
            className="-m-1 flex max-h-[368px] flex-col gap-px overflow-y-auto p-1"
          >
            <span id={groupId} className="sr-only">
              {t("automations.test.example.recent")}
            </span>
            {list.map((e, i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={picked === i}
                data-example={i}
                tabIndex={picked === i ? 0 : -1}
                autoFocus={i === 0 ? true : undefined}
                onClick={() => setPicked(i)}
                onDoubleClick={start}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") {
                    ev.preventDefault();
                    start();
                  } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
                    ev.preventDefault();
                    const n = (i + (ev.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
                    setPicked(n);
                    (
                      ev.currentTarget.parentElement?.querySelector(
                        `[data-example="${n}"]`,
                      ) as HTMLElement | null
                    )?.focus();
                  }
                }}
                className={`flex items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-ink/6 ${picked === i ? "bg-ink/10" : ""}`}
              >
                <span className="pt-0.5">
                  <RadioDot checked={picked === i} />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-md text-ink">
                    {e.code && <span className="num mr-2 text-xs font-semibold">{e.code}</span>}
                    {exampleLine(e, i18n.language)}
                  </span>
                  {exampleSecond(e) && (
                    <span className="text-xs text-ink-muted">{exampleSecond(e)}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )
      ) : (
        <WriteOne
          fields={fields}
          values={form}
          files={filesOf(list, fields)}
          formOnly={formOnly}
          onChange={setValues}
        />
      )}
    </Dialog>
  );
}

/** «Rossi Srl · CRM + Website · €18,400 · Oct 24». */
function exampleLine(e: SimulationExample, language: string): string {
  const parts = [e.label];
  const amount = lookup(e.event, "trattativa.importo");
  if (typeof amount === "number")
    parts.push(
      new Intl.NumberFormat(language, {
        style: "currency",
        currency: "EUR",
        maximumFractionDigits: 0,
      }).format(amount),
    );
  if (e.at) parts.push(shortDate(e.at.length === 10 ? `${e.at}T12:00:00Z` : e.at, language));
  return parts.join(" · ");
}

/** La seconda riga: un allegato, o i primi altri dati dell'evento (12px). */
function exampleSecond(e: SimulationExample): string | null {
  const file = lookup(e.event, "trattativa.contratto");
  if (file && typeof file === "object") return show((file as Values).nome);
  const leaves: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string" && v.trim() !== "" && v !== e.label) leaves.push(v);
    else if (v && typeof v === "object" && !Array.isArray(v)) Object.values(v).forEach(walk);
  };
  walk(e.event);
  return leaves.length > 0 ? leaves.slice(0, 2).join(" · ") : null;
}

function WriteOne({
  fields,
  values,
  files,
  formOnly,
  onChange,
}: {
  fields: DataField[];
  values: Values;
  files: Values[];
  formOnly: boolean;
  onChange: (v: Values) => void;
}) {
  const { t } = useTranslation();
  return (
    <div data-write-one className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">{t("automations.test.example.writeHint")}</p>
      {fields.map((f) => (
        <FieldInput
          key={f.key}
          field={f}
          label={
            formOnly && f.key === "avvio.data"
              ? t("automations.test.example.whenItStarts")
              : f.label
          }
          value={lookup(values, f.key)}
          files={files}
          onChange={(v) => onChange(setAt(values, f.key, v))}
        />
      ))}
    </div>
  );
}

function FieldInput({
  field,
  label,
  value,
  files,
  onChange,
}: {
  field: DataField;
  label: string;
  value: unknown;
  files: Values[];
  onChange: (v: unknown) => void;
}) {
  const { t } = useTranslation();
  const people = usePeople().data ?? [];
  const id = useId();
  const labelClass = "flex flex-col gap-1 text-sm text-ink-muted";
  switch (field.type) {
    case "list": {
      const rows = Array.isArray(value) ? (value as Values[]) : [];
      const sub = field.of ?? [];
      return (
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-1 text-sm text-ink-muted">{label}</legend>
          {rows.map((r, i) => (
            <div
              key={i}
              role="group"
              aria-label={t("automations.test.example.rowN", { n: i + 1 })}
              className="flex flex-wrap items-end gap-2 border-l border-rule pl-3"
            >
              {sub.map((s) => (
                <div key={s.key} className="min-w-40 flex-1">
                  <FieldInput
                    field={s}
                    label={s.label}
                    value={r?.[s.key]}
                    files={files}
                    onChange={(v) => {
                      const next = rows.map((x, k) => (k === i ? { ...x, [s.key]: v } : x));
                      onChange(next);
                    }}
                  />
                </div>
              ))}
              <button
                type="button"
                className={secondaryButton}
                onClick={() => onChange(rows.filter((_, k) => k !== i))}
              >
                {t("automations.test.example.removeRow", { n: i + 1 })}
              </button>
            </div>
          ))}
          <button
            type="button"
            className={`${secondaryButton} self-start`}
            onClick={() => onChange([...rows, {}])}
          >
            {t("automations.test.example.addRow")}
          </button>
        </fieldset>
      );
    }
    case "person":
      return (
        <label htmlFor={id} className={labelClass}>
          {label}
          <select
            id={id}
            className={`${inputClass} h-8`}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value || null)}
          >
            <option value="">{t("automations.test.example.noPerson")}</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      );
    case "file": {
      const name = value && typeof value === "object" ? show((value as Values).nome) : "";
      return (
        <label htmlFor={id} className={labelClass}>
          {label}
          <select
            id={id}
            className={`${inputClass} h-8`}
            value={name}
            onChange={(e) => onChange(files.find((f) => f.nome === e.target.value) ?? null)}
          >
            <option value="">{t("automations.test.example.noFile")}</option>
            {files.map((f) => (
              <option key={String(f.nome)} value={String(f.nome)}>
                {String(f.nome)}
              </option>
            ))}
          </select>
        </label>
      );
    }
    case "boolean":
      return (
        <label className="flex h-8 items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="accent-ink"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {label}
        </label>
      );
    default:
      return (
        <label htmlFor={id} className={labelClass}>
          {label}
          <input
            id={id}
            type={
              field.type === "number"
                ? "number"
                : field.type === "date"
                  ? "date"
                  : field.type === "email"
                    ? "email"
                    : "text"
            }
            className={inputClass}
            value={value === undefined || value === null ? "" : String(value)}
            onChange={(e) =>
              onChange(
                field.type === "number"
                  ? e.target.value === ""
                    ? null
                    : Number(e.target.value)
                  : e.target.value,
              )
            }
          />
        </label>
      );
  }
}
