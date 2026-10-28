import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useCreateWidget,
  useDeleteWidget,
  useRepositorySettings,
  useSupportWidgets,
  useUpdateWidget,
  type SupportWidgetView,
  type WidgetInput,
} from "../../data/queries";
import { copyText, downloadText } from "../../tasks-ui/exportFile";
import { CheckBox } from "../../tasks-ui/Menu";
import { PageEmpty, PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import {
  CrossGlyph,
  primaryButton,
  quietButton,
  secondaryButton,
} from "../claude/conversation/parts";
import { inputClass } from "../../tasks-ui/Dialog";
import { widgetGuide, widgetGuideFile, widgetSnippet } from "./widgetSnippet";

// La vista Widget della sezione (shape support.md §6, [A 1], [A 16], R-K13):
// solo per chi ha `widget.manage`. Righe di 48 px (nome · On/Off in parole ·
// conversazioni · Edit), «New widget» in testa; nuovo e modifica nel pannello
// agganciato a destra coi campi del web; sotto, per un widget salvato, lo
// snippet e la guida. Eliminare chiede conferma sul posto: le conversazioni
// restano.

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
        <pre className="max-h-48 overflow-auto rounded-md border border-rule bg-ground px-3 py-2 font-mono text-xs whitespace-pre text-ink">
          <code>{text}</code>
        </pre>
      )}
    </section>
  );
}

function WidgetPanel({
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
              <input
                type="color"
                aria-label={t("support.widgets.fields.color")}
                value={f.accentColor}
                onChange={(e) => set({ accentColor: e.target.value })}
                className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-rule-strong bg-transparent"
              />
              <input
                id={`${id}-color`}
                value={f.accentColor}
                onChange={(e) => set({ accentColor: e.target.value })}
                className={`${inputClass} num`}
              />
            </span>
          </Field>
          <Field label={t("support.widgets.fields.language")} htmlFor={`${id}-lang`}>
            <select
              id={`${id}-lang`}
              value={f.language}
              onChange={(e) => set({ language: e.target.value as Fields["language"] })}
              className={inputClass}
            >
              <option value="it">{t("support.widgets.fields.languageIt")}</option>
              <option value="en">{t("support.widgets.fields.languageEn")}</option>
            </select>
          </Field>
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

export function Widgets({
  projectId,
  projectCode,
  open,
}: {
  projectId: string;
  projectCode: string;
  /** Il pannello aperto: l'id di un widget o `new`. */
  open: string | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const q = useSupportWidgets(projectId);
  const setOpen = (widget: string | null) =>
    void navigate({
      to: "/p/$code/$section",
      params: { code: projectCode, section: "support" },
      search: { view: "widgets", widget: widget ?? undefined } as never,
      replace: true,
    });
  const widgets = q.data?.widgets ?? [];
  const current = open && open !== "new" ? (widgets.find((w) => w.id === open) ?? null) : null;
  const panelOpen = open === "new" || current !== null;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-8 pt-4 pb-10">
        <div className="flex max-w-[760px] flex-col gap-3">
          <div>
            <button type="button" className={primaryButton} onClick={() => setOpen("new")}>
              {t("support.widgets.new")}
            </button>
          </div>
          {q.isError ? (
            <PageError message={t("support.widgets.error")} onRetry={() => void q.refetch()} />
          ) : !q.data ? (
            <PageSkeleton rows={2} />
          ) : widgets.length === 0 ? (
            <PageEmpty title={t("support.widgets.empty")} />
          ) : (
            <ul aria-label={t("support.views.widgets")} className="@container border-t border-rule">
              {widgets.map((w) => (
                <li
                  key={w.id}
                  data-widget-row={w.id}
                  aria-current={w.id === open || undefined}
                  className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule px-3 py-2 aria-[current]:bg-ink/10"
                >
                  {/* Stretta (pannello aperto a 1024): il nome ha una riga sua, mai nascosto. */}
                  <span
                    title={w.name}
                    className="min-w-0 basis-full truncate text-md font-medium text-ink @[440px]:flex-1 @[440px]:basis-auto"
                  >
                    {w.name}
                  </span>
                  <span className={`text-sm ${w.enabled ? "text-ink" : "text-ink-muted"}`}>
                    {w.enabled ? t("support.widgets.on") : t("support.widgets.off")}
                  </span>
                  <span className="num text-sm text-ink-muted @[440px]:min-w-32 @[440px]:text-right">
                    {t("support.widgets.conversations", { count: w.conversationCount })}
                  </span>
                  <button
                    type="button"
                    className={secondaryButton}
                    aria-label={t("support.widgets.editNamed", { name: w.name })}
                    onClick={() => setOpen(w.id)}
                  >
                    {t("support.widgets.edit")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {panelOpen && (
        <WidgetPanel
          key={open!}
          projectId={projectId}
          widget={current}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
