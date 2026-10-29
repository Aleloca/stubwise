import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useCreateWidget,
  useDeleteWidget,
  useRepositorySettings,
  useUpdateWidget,
  type SupportWidgetView,
  type WidgetInput,
} from "../../data/queries";
import { copyText, downloadText } from "../../tasks-ui/exportFile";
import { CheckBox } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import {
  CrossGlyph,
  primaryButton,
  quietButton,
  secondaryButton,
} from "../claude/conversation/parts";
import { inputClass } from "../../tasks-ui/Dialog";
import { widgetGuide, widgetGuideFile, widgetSnippet } from "./widgetSnippet";

// Il pannello di un widget (nuovo o in modifica), agganciato a destra nella
// vista Widget: i campi del web, poi, per un widget salvato, lo snippet e la
// guida. Separato da `Widgets.tsx` (la lista) per tenere i file corti.

/** Due o tre scelte esclusive in una riga: un gruppo di radio disegnato. */
function Segmented<T extends string>({
  labelledBy,
  value,
  options,
  onChange,
}: {
  labelledBy: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      className="flex w-fit rounded-md border border-rule-strong p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`h-7 rounded-[5px] px-2.5 text-sm transition-colors duration-[var(--duration-fast)] ease-out ${value === o.value ? "bg-ink/10 font-medium text-ink" : "text-ink-muted hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

type Fields = Required<Omit<WidgetInput, "dailyMessageCap" | "dailyRequestCap">> & {
  dailyMessageCap: string;
  dailyRequestCap: string;
};

const fieldsOf = (w: SupportWidgetView | null): Fields => ({
  name: w?.name ?? "",
  enabled: w?.enabled ?? false,
  sourceRepositoryIds: w?.sourceRepositoryIds ?? [],
  origins: w?.origins ?? [],
  title: w?.title ?? "Help",
  welcomeMessage: w?.welcomeMessage ?? "Hi! How can we help?",
  instructions: w?.instructions ?? "",
  accentColor: w?.accentColor ?? "#22c55e",
  language: w?.language ?? "it",
  dailyMessageCap: w?.dailyMessageCap?.toString() ?? "",
  dailyRequestCap: w?.dailyRequestCap?.toString() ?? "",
});

/** Un tetto scritto: vuoto = il default d'istanza; un testo non numerico lo ferma il livello dati. */
const capOf = (v: string): number | null => (v.trim() === "" ? null : Number(v.trim()));

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

function CopyBlock({
  title,
  text,
  children,
}: {
  title: string;
  text?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-t border-rule pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="heading-group min-w-0 flex-1">{title}</h3>
        {children}
      </div>
      {text && (
        <pre className="max-h-48 overflow-auto rounded-md border border-rule bg-ground px-3 py-2 font-code whitespace-pre text-ink">
          <code>{text}</code>
        </pre>
      )}
    </section>
  );
}

export function WidgetPanel({
  projectId,
  widget,
  onClose,
}: {
  projectId: string;
  widget: SupportWidgetView | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const id = useId();
  const create = useCreateWidget();
  const update = useUpdateWidget();
  const remove = useDeleteWidget();
  const repos = useRepositorySettings(projectId).data?.repositories ?? [];
  const [f, setF] = useState<Fields>(() => fieldsOf(widget));
  const [origins, setOrigins] = useState(() => (widget?.origins ?? []).join("\n"));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => firstRef.current?.focus(), []);
  const set = (patch: Partial<Fields>) => setF((old) => ({ ...old, ...patch }));

  const input = (): WidgetInput => ({
    ...f,
    origins: origins
      .split("\n")
      .map((o) => o.trim())
      .filter(Boolean),
    dailyMessageCap: capOf(f.dailyMessageCap),
    dailyRequestCap: capOf(f.dailyRequestCap),
  });
  const failed = (e: unknown) => {
    const m = e instanceof Error ? /^invalid: (\w+)$/.exec(e.message) : null;
    setError(
      m
        ? t(`support.widgets.invalid.${m[1]}`, t("support.widgets.saveError"))
        : t("support.widgets.saveError"),
    );
  };
  const save = () => {
    setError(null);
    if (widget) {
      update.mutate(
        { id: widget.id, patch: input() },
        { onSuccess: () => toast.show(t("support.widgets.saved")), onError: failed },
      );
    } else {
      create.mutate(
        { projectId, input: input() },
        {
          onSuccess: (w) => {
            toast.show(t("support.widgets.created", { name: w.name }));
            onClose();
          },
          onError: failed,
        },
      );
    }
  };

  const snippet = widget ? widgetSnippet(widget) : "";
  const guide = widget ? widgetGuide(widget) : "";
  const copy = (text: string) =>
    copyText(text).then(
      () => toast.show(t("support.widgets.copied")),
      () => toast.error(t("support.widgets.copyError")),
    );

  return (
    <aside
      role="complementary"
      aria-labelledby={`${id}-title`}
      data-widget-panel={widget?.id ?? "new"}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          onClose();
        }
      }}
      className="panel-enter flex min-h-0 w-[480px] max-w-full shrink-0 flex-col border-l border-rule bg-surface"
    >
      <header className="flex items-center gap-2 border-b border-rule px-5 py-3">
        <h2 id={`${id}-title`} className="min-w-0 flex-1 truncate text-lg font-semibold text-ink">
          {widget
            ? t("support.widgets.panelEdit", { name: widget.name })
            : t("support.widgets.new")}
        </h2>
        <button
          type="button"
          aria-label={t("support.widgets.close")}
          title={t("support.widgets.close")}
          onClick={onClose}
          className={quietButton}
        >
          <CrossGlyph />
        </button>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4"
      >
        <Field label={t("support.widgets.fields.name")} htmlFor={`${id}-name`}>
          <input
            ref={firstRef}
            id={`${id}-name`}
            value={f.name}
            onChange={(e) => set({ name: e.target.value })}
            className={inputClass}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={f.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
            className="size-4 accent-ink"
          />
          {t("support.widgets.fields.enabled")}
        </label>
        <fieldset className="flex flex-col gap-1">
          <legend className="pb-1 text-sm font-medium text-ink">
            {t("support.widgets.fields.sources")}
          </legend>
          {repos.length === 0 ? (
            <p className="text-xs text-ink-muted">{t("support.widgets.fields.noSources")}</p>
          ) : (
            repos.map((r) => {
              const on = f.sourceRepositoryIds.includes(r.id);
              return (
                <label key={r.id} className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on}
                    onChange={() =>
                      set({
                        sourceRepositoryIds: on
                          ? f.sourceRepositoryIds.filter((x) => x !== r.id)
                          : [...f.sourceRepositoryIds, r.id],
                      })
                    }
                  />
                  <CheckBox checked={on} />
                  {r.fullName}
                </label>
              );
            })
          )}
        </fieldset>
        <Field
          label={t("support.widgets.fields.origins")}
          htmlFor={`${id}-origins`}
          hint={t("support.widgets.fields.originsHint")}
        >
          <textarea
            id={`${id}-origins`}
            rows={2}
            value={origins}
            onChange={(e) => setOrigins(e.target.value)}
            className={`${inputClass} resize-y`}
          />
        </Field>
        <Field label={t("support.widgets.fields.title")} htmlFor={`${id}-title-f`}>
          <input
            id={`${id}-title-f`}
            value={f.title}
            onChange={(e) => set({ title: e.target.value })}
            className={inputClass}
          />
        </Field>
        <Field label={t("support.widgets.fields.welcome")} htmlFor={`${id}-welcome`}>
          <textarea
            id={`${id}-welcome`}
            rows={2}
            value={f.welcomeMessage}
            onChange={(e) => set({ welcomeMessage: e.target.value })}
            className={`${inputClass} resize-y`}
          />
        </Field>
        <Field
          label={t("support.widgets.fields.instructions")}
          htmlFor={`${id}-instructions`}
          hint={t("support.widgets.fields.instructionsHint")}
        >
          <textarea
            id={`${id}-instructions`}
            rows={3}
            value={f.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
            className={`${inputClass} resize-y`}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("support.widgets.fields.color")} htmlFor={`${id}-color`}>
            <span className="flex items-center gap-2">
              {/* Il campione del colore: il selettore del sistema si apre al
                  clic, ma il controllo è disegnato come gli altri campi. */}
              <span
                className="relative size-8 shrink-0 rounded-md border border-rule-strong focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--color-focus)]"
                style={{ background: f.accentColor }}
              >
                <input
                  type="color"
                  aria-label={t("support.widgets.fields.color")}
                  value={f.accentColor}
                  onChange={(e) => set({ accentColor: e.target.value })}
                  className="absolute inset-0 size-full cursor-pointer opacity-0"
                />
              </span>
              <input
                id={`${id}-color`}
                value={f.accentColor}
                onChange={(e) => set({ accentColor: e.target.value })}
                className={`${inputClass} num`}
              />
            </span>
          </Field>
          <div className="flex flex-col gap-1">
            <span id={`${id}-lang`} className="text-sm font-medium text-ink">
              {t("support.widgets.fields.language")}
            </span>
            <Segmented
              labelledBy={`${id}-lang`}
              value={f.language}
              options={[
                { value: "it", label: t("support.widgets.fields.languageIt") },
                { value: "en", label: t("support.widgets.fields.languageEn") },
              ]}
              onChange={(language) => set({ language })}
            />
          </div>
          <Field
            label={t("support.widgets.fields.messageCap")}
            htmlFor={`${id}-mcap`}
            hint={t("support.widgets.fields.capHint")}
          >
            <input
              id={`${id}-mcap`}
              inputMode="numeric"
              value={f.dailyMessageCap}
              onChange={(e) => set({ dailyMessageCap: e.target.value })}
              className={`${inputClass} num`}
            />
          </Field>
          <Field
            label={t("support.widgets.fields.requestCap")}
            htmlFor={`${id}-rcap`}
            hint={t("support.widgets.fields.capHint")}
          >
            <input
              id={`${id}-rcap`}
              inputMode="numeric"
              value={f.dailyRequestCap}
              onChange={(e) => set({ dailyRequestCap: e.target.value })}
              className={`${inputClass} num`}
            />
          </Field>
        </div>
        {error && (
          <p role="alert" className="text-sm text-critical">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <button
            type="submit"
            className={primaryButton}
            disabled={create.isPending || update.isPending}
          >
            {widget ? t("support.widgets.save") : t("support.widgets.create")}
          </button>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("support.widgets.cancel")}
          </button>
        </div>
        {widget && (
          <>
            <CopyBlock title={t("support.widgets.snippet")} text={snippet}>
              <button type="button" className={secondaryButton} onClick={() => void copy(snippet)}>
                {t("support.widgets.copySnippet")}
              </button>
            </CopyBlock>
            <CopyBlock title={t("support.widgets.guide")}>
              <button type="button" className={secondaryButton} onClick={() => void copy(guide)}>
                {t("support.widgets.copyGuide")}
              </button>
              <button
                type="button"
                className={secondaryButton}
                onClick={() => downloadText(widgetGuideFile(widget), guide)}
              >
                {t("support.widgets.downloadGuide")}
              </button>
            </CopyBlock>
            <section className="flex flex-col items-start gap-2 border-t border-rule pt-4">
              {confirmDelete ? (
                <div role="group" className="flex flex-wrap items-center gap-2 text-sm text-ink">
                  <span>{t("support.widgets.deleteAsk", { name: widget.name })}</span>
                  <button
                    type="button"
                    autoFocus
                    className="inline-flex h-8 items-center rounded-md bg-critical px-3 text-sm font-semibold text-ground hover:opacity-90"
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate(widget.id, {
                        onSuccess: () => {
                          toast.show(t("support.widgets.deleted", { name: widget.name }));
                          onClose();
                        },
                        onError: () => toast.error(t("support.widgets.deleteError")),
                      })
                    }
                  >
                    {t("support.widgets.deleteConfirm")}
                  </button>
                  <button
                    type="button"
                    className={quietButton}
                    onClick={() => setConfirmDelete(false)}
                  >
                    {t("support.widgets.cancel")}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="rounded-sm text-sm font-medium text-critical underline-offset-4 hover:underline"
                >
                  {t("support.widgets.delete")}
                </button>
              )}
            </section>
          </>
        )}
      </form>
    </aside>
  );
}
