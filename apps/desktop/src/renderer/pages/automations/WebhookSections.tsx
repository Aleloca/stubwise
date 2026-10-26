import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  usePreviewWebhookExample,
  useRegenerateWebhookAddress,
  useSetWebhookExample,
  useUpdateWebhookField,
} from "../../data/queries";
import type {
  AutomationSourceView,
  DataField,
  FieldType,
  WebhookExamplePreview,
} from "../../data/types";
import { Dialog, inputClass } from "../../tasks-ui/Dialog";
import { MenuGroup, itemClass } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { MenuButton, primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import { MoreGlyph, WarningGlyph } from "./glyphs";
import { PrototypeBox } from "./shared";
import { useSimulate } from "./sourceHelpers";

// Le sezioni di un webhook in arrivo nel pannello (shape automation-sources.md
// §«Webhook in arrivo»): l'indirizzo (copia, rigenera con conferma, [A 6]),
// l'esempio (incolla o sostituisci; JSON non valido detto sotto l'area; i
// campi usati che sparirebbero segnalati prima di confermare, [A 8]), i campi
// con etichetta e tipo modificabili, e «Simulate an event» del prototipo.

const FIELD_TYPES: FieldType[] = [
  "text",
  "number",
  "date",
  "email",
  "person",
  "list",
  "file",
  "boolean",
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-t border-rule px-4 py-3">
      <h3 className="heading-group">{title}</h3>
      {children}
    </section>
  );
}

export function AddressSection({ source }: { source: AutomationSourceView }) {
  const { t } = useTranslation();
  const toast = useToast();
  const regenerate = useRegenerateWebhookAddress();
  const [confirming, setConfirming] = useState(false);
  const address = source.address ?? "";
  // L'indirizzo con l'ellissi a metà: resta leggibile l'inizio e la fine.
  const shown = address.length > 44 ? `${address.slice(0, 30)}…${address.slice(-10)}` : address;
  return (
    <Section title={t("automations.sources.address")}>
      <div className="flex items-center gap-1">
        <code
          data-webhook-address
          title={address}
          className="min-w-0 flex-1 truncate text-sm text-ink"
        >
          {shown}
        </code>
        <button
          type="button"
          className={`${secondaryButton} h-7`}
          onClick={() => {
            void navigator.clipboard?.writeText(address).catch(() => {});
            toast.show(t("automations.toast.addressCopied"));
          }}
        >
          {t("automations.sources.copy")}
        </button>
        {source.permissions.manage && (
          <MenuButton
            menuLabel={t("automations.sources.addressMenu")}
            ariaLabel={t("automations.sources.addressMenu")}
            align="right"
            className={`${quietButton} h-7 w-7 justify-center px-0`}
            label={<MoreGlyph />}
          >
            {(close) => (
              <MenuGroup>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={itemClass}
                  onClick={() => {
                    close();
                    setConfirming(true);
                  }}
                >
                  {t("automations.sources.regenerate")}
                </button>
              </MenuGroup>
            )}
          </MenuButton>
        )}
      </div>
      <p className="text-xs text-ink-muted">{t("automations.sources.postHint")}</p>
      {confirming && (
        <Dialog
          title={t("automations.sources.regenerateTitle")}
          width={400}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button
                type="button"
                className={secondaryButton}
                onClick={() => setConfirming(false)}
              >
                {t("automations.actions.cancel")}
              </button>
              <button
                type="button"
                className={primaryButton}
                disabled={regenerate.isPending}
                onClick={() =>
                  regenerate.mutate(source.id, {
                    onSuccess: () => {
                      setConfirming(false);
                      toast.show(t("automations.toast.addressRegenerated"));
                    },
                    onError: () =>
                      toast.error(t("automations.toast.connectError", { name: source.name })),
                  })
                }
              >
                {t("automations.sources.regenerate")}
              </button>
            </>
          }
        >
          <p className="text-md text-ink">{t("automations.sources.regenerateBody")}</p>
        </Dialog>
      )}
    </Section>
  );
}

/** «Replace example» / «Paste an example»: l'area di testo, il controllo, la conferma. */
function ExampleEditor({ source, onDone }: { source: AutomationSourceView; onDone: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const preview = usePreviewWebhookExample();
  const save = useSetWebhookExample();
  const [json, setJson] = useState(() =>
    source.sampleEvents[0] ? JSON.stringify(source.sampleEvents[0], null, 2) : "",
  );
  const areaId = useId();
  const errorId = useId();
  // Solo la risposta all'ultimo testo conta: una lettura vecchia che arriva
  // dopo non può accendere «Save» su una validazione superata.
  const seq = useRef(0);
  const [result, setResult] = useState<{ seq: number; data: WebhookExamplePreview } | null>(null);
  const { mutate } = preview;
  useEffect(() => {
    const mine = ++seq.current;
    if (!json.trim()) return;
    mutate(
      { id: source.id, json },
      { onSuccess: (data) => mine === seq.current && setResult({ seq: mine, data }) },
    );
  }, [json, source.id, mutate]);
  const current = result && result.seq === seq.current && json.trim() ? result.data : undefined;
  const invalid = current?.error ?? null;
  const missing = current?.missing ?? [];
  const usedCodes = [...new Set(missing.flatMap((m) => m.usedBy))];
  return (
    <div className="flex flex-col gap-2">
      <textarea
        id={areaId}
        aria-label={t("automations.sources.exampleArea")}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={invalid ? errorId : undefined}
        className={`${inputClass} min-h-40 font-mono text-xs`}
        value={json}
        onChange={(e) => setJson(e.target.value)}
      />
      {invalid && (
        <p id={errorId} role="alert" className="text-sm text-critical">
          {t("automations.sources.invalidJson", { detail: invalid })}
        </p>
      )}
      {missing.length > 0 && (
        <div data-missing-fields className="flex flex-col gap-1">
          {missing.map((m) => (
            <p key={m.key} className="flex items-start gap-2 text-sm text-ink" title={m.key}>
              <WarningGlyph />
              {t("automations.sources.missingField", {
                label: m.label,
                codes: m.usedBy.join(", "),
              })}
            </p>
          ))}
          <p className="text-sm text-ink-muted">
            {t("automations.sources.missingConfirm", {
              codes: usedCodes.join(", "),
              count: missing.length,
            })}
          </p>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button type="button" className={secondaryButton} onClick={onDone}>
          {t("automations.actions.cancel")}
        </button>
        <button
          type="button"
          className={`${primaryButton} disabled:opacity-40`}
          disabled={!json.trim() || !!invalid || !current || save.isPending}
          onClick={() =>
            save.mutate(
              { id: source.id, json },
              {
                onSuccess: () => {
                  onDone();
                  toast.show(t("automations.toast.exampleSaved"));
                },
                onError: () => toast.error(t("automations.toast.exampleError")),
              },
            )
          }
        >
          {missing.length > 0
            ? t("automations.sources.replaceAnyway")
            : t("automations.sources.saveExample")}
        </button>
      </div>
    </div>
  );
}

export function ExampleSection({ source }: { source: AutomationSourceView }) {
  const { t } = useTranslation();
  const empty = source.sampleEvents.length === 0;
  const [editing, setEditing] = useState(false);
  return (
    <Section title={t("automations.sources.example")}>
      {editing ? (
        <ExampleEditor source={source} onDone={() => setEditing(false)} />
      ) : empty ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-ink-muted">{t("automations.sources.noExample")}</p>
          {source.permissions.manage && (
            <button type="button" className={primaryButton} onClick={() => setEditing(true)}>
              {t("automations.sources.pasteExample")}
            </button>
          )}
        </div>
      ) : (
        <>
          <pre
            data-webhook-example
            className="max-h-80 overflow-auto rounded-md border border-rule p-2 font-mono text-xs text-ink"
          >
            {JSON.stringify(source.sampleEvents[0], null, 2)}
          </pre>
          {source.permissions.manage && (
            <button
              type="button"
              className={`${quietButton} h-7 self-start`}
              onClick={() => setEditing(true)}
            >
              {t("automations.sources.replaceExample")}
            </button>
          )}
        </>
      )}
    </Section>
  );
}

/** Il valore d'esempio di un campo (`cliente.nome` → «Rossi Srl»). */
function exampleValue(source: AutomationSourceView, key: string): string {
  const v = key
    .split(".")
    .reduce<unknown>(
      (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
      source.sampleEvents[0],
    );
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return String(v.length);
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function FieldRow({
  source,
  field,
  path,
  depth,
}: {
  source: AutomationSourceView;
  field: DataField;
  path: string;
  depth: number;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const update = useUpdateWebhookField();
  const [label, setLabel] = useState(field.label);
  const manage = source.permissions.manage;
  const save = (patch: { label?: string; type?: FieldType }) =>
    update.mutate(
      { id: source.id, key: path, ...patch },
      { onError: () => toast.error(t("automations.toast.fieldError")) },
    );
  return (
    <>
      <div
        role="row"
        data-field={path}
        className="grid min-h-8 grid-cols-[minmax(0,1.3fr)_96px_minmax(0,1fr)] items-center gap-2"
        title={path}
      >
        <span
          role="cell"
          className="flex min-w-0 items-center gap-1"
          style={{ paddingLeft: depth * 14 }}
        >
          {depth > 0 && (
            <span aria-hidden="true" className="text-ink-faint">
              →
            </span>
          )}
          {manage ? (
            <input
              aria-label={t("automations.sources.fieldLabel", { key: path })}
              className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-sm text-ink hover:border-rule-strong focus-visible:border-rule-strong"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={() => {
                if (label.trim() && label !== field.label) save({ label });
                else setLabel(field.label);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          ) : (
            <span className="truncate text-sm text-ink">{field.label}</span>
          )}
        </span>
        <span role="cell">
          {manage ? (
            <select
              aria-label={t("automations.sources.fieldType", { key: path })}
              className="h-7 w-full rounded-md border border-rule bg-transparent px-1 text-xs text-ink-muted"
              value={field.type}
              onChange={(e) => save({ type: e.target.value as FieldType })}
            >
              {FIELD_TYPES.map((ty) => (
                <option key={ty} value={ty}>
                  {t(`automations.fieldType.${ty}`)}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-ink-muted">
              {t(`automations.fieldType.${field.type}`)}
            </span>
          )}
        </span>
        <span role="cell" className="truncate text-xs text-ink-muted">
          {depth === 0 ? exampleValue(source, path) : ""}
        </span>
      </div>
      {field.of?.map((c) => (
        <FieldRow
          key={c.key}
          source={source}
          field={c}
          path={`${path}.${c.key}`}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

/** I campi del webhook: etichetta (modificabile in posto), tipo, valore d'esempio; la chiave nel tooltip. */
export function FieldsTable({ source }: { source: AutomationSourceView }) {
  const { t } = useTranslation();
  return (
    <Section title={t("automations.sources.fields")}>
      {source.fields.length === 0 ? (
        <p className="text-sm text-ink-muted">{t("automations.sources.noFields")}</p>
      ) : (
        <div role="table" aria-label={t("automations.sources.fields")} className="flex flex-col">
          <div
            role="row"
            className="grid grid-cols-[minmax(0,1.3fr)_96px_minmax(0,1fr)] gap-2 pb-1 text-xs font-semibold text-ink-muted"
          >
            <span role="columnheader">{t("automations.sources.colLabel")}</span>
            <span role="columnheader">{t("automations.sources.colType")}</span>
            <span role="columnheader">{t("automations.sources.colExample")}</span>
          </div>
          {source.fields.map((f) => (
            <FieldRow
              key={`${f.key}:${f.label}:${f.type}`}
              source={source}
              field={f}
              path={f.key}
              depth={0}
            />
          ))}
        </div>
      )}
      <p className="text-xs text-ink-muted">{t("automations.sources.fieldsHint")}</p>
    </Section>
  );
}

/** «Simulate an event» di un webhook: «Send the example» e «Edit and send». */
export function SimulateWebhook({ source }: { source: AutomationSourceView }) {
  const { t } = useTranslation();
  const simulate = useSimulate(source);
  const [editing, setEditing] = useState(false);
  const [json, setJson] = useState("");
  let parsed: unknown = undefined;
  let error: string | null = null;
  if (editing) {
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  const off = source.status !== "connected";
  const hasExample = source.sampleEvents.length > 0;
  return (
    <PrototypeBox label={t("automations.sources.simulate")}>
      {off ? (
        <p className="text-sm text-ink-muted">
          {t("automations.sources.simulateOff", { name: source.name })}
        </p>
      ) : !hasExample && !editing ? (
        <p className="text-sm text-ink-muted">{t("automations.sources.simulateNoExample")}</p>
      ) : editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={t("automations.sources.eventArea")}
            className={`${inputClass} min-h-32 font-mono text-xs`}
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
          {error && (
            <p role="alert" className="text-sm text-critical">
              {t("automations.sources.invalidJson", { detail: error })}
            </p>
          )}
          <div className="flex gap-2">
            <button type="button" className={secondaryButton} onClick={() => setEditing(false)}>
              {t("automations.actions.cancel")}
            </button>
            <button
              type="button"
              className={`${primaryButton} disabled:opacity-40`}
              disabled={!!error}
              onClick={() => {
                simulate({ payload: parsed });
                setEditing(false);
              }}
            >
              {t("automations.sources.send")}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`${secondaryButton} h-7`} onClick={() => simulate(0)}>
            {t("automations.sources.sendExample")}
          </button>
          <button
            type="button"
            className={`${quietButton} h-7`}
            onClick={() => {
              setJson(JSON.stringify(source.sampleEvents[0] ?? {}, null, 2));
              setEditing(true);
            }}
          >
            {t("automations.sources.editAndSend")}
          </button>
        </div>
      )}
    </PrototypeBox>
  );
}
