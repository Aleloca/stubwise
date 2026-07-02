import {
  formatNotification,
  sampleEvents,
  type NotificationEvent,
} from "@stubwise/notifications/format";
import type { Language } from "@stubwise/shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  postTestNotification,
  putInstanceSettings,
  putNotificationSettings,
  type InstanceSettingsPatch,
  type NotificationFormat,
  type NotificationSettings,
  type TestNotificationResult,
} from "../lib/api";
import { instanceSettingsQueryOptions, notificationSettingsQueryOptions } from "../lib/queries";
import { CollapsibleSection } from "./collapsible-section";

/** Le opzioni di formato del webhook; "slack"/"discord" sono nomi propri,
 * "generic" ha un'etichetta tradotta a render-time (notifications:formatGeneric). */
const FORMAT_OPTIONS: { value: NotificationFormat; labelKey?: string; literal?: string }[] = [
  { value: "slack", literal: "Slack" },
  { value: "discord", literal: "Discord" },
  { value: "generic", labelKey: "notifications:formatGeneric" },
];

/** I toggle per-evento; la `labelKey` punta a `notifications:toggles.*`. */
const EVENT_TOGGLES: { key: keyof NotificationSettings; labelKey: string }[] = [
  { key: "notifyTicketCreated", labelKey: "notifications:toggles.ticketCreated" },
  { key: "notifyPrOpened", labelKey: "notifications:toggles.prOpened" },
  { key: "notifyPrClosed", labelKey: "notifications:toggles.prClosed" },
  { key: "notifyJobHeld", labelKey: "notifications:toggles.jobHeld" },
  { key: "notifyPlanReview", labelKey: "notifications:toggles.planReview" },
  { key: "notifyBudgetHeld", labelKey: "notifications:toggles.budgetHeld" },
  { key: "notifyReviewCompleted", labelKey: "notifications:toggles.reviewCompleted" },
  { key: "notifyJobFailed", labelKey: "notifications:toggles.jobFailed" },
];

/** Eventi d'esempio per il selettore d'anteprima; `labelKey` → `notifications:samples.*`. */
const SAMPLE_LABELS: { kind: NotificationEvent["kind"]; labelKey: string }[] = [
  { kind: "ticket.created", labelKey: "notifications:samples.ticketCreated" },
  { kind: "job.pr_opened", labelKey: "notifications:samples.prOpened" },
  { kind: "job.pr_closed", labelKey: "notifications:samples.prClosed" },
  { kind: "job.held", labelKey: "notifications:samples.jobHeld" },
  { kind: "job.plan_review", labelKey: "notifications:samples.planReview" },
  { kind: "review.completed", labelKey: "notifications:samples.reviewCompleted" },
  { kind: "job.failed", labelKey: "notifications:samples.jobFailed" },
];

/** Placeholder dell'URL webhook in base al formato selezionato (URL letterali). */
const URL_PLACEHOLDER: Record<NotificationFormat, string> = {
  slack: "https://hooks.slack.com/services/…",
  discord: "https://discord.com/api/webhooks/…",
  generic: "https://example.com/webhooks/stubwise",
};

/** Nomi dei campi del payload generico; la descrizione è in `notifications:generic.fields.*`. */
const GENERIC_FIELDS: { name: string; descKey: string }[] = [
  { name: "event", descKey: "notifications:generic.fields.event" },
  { name: "ticketNumber", descKey: "notifications:generic.fields.ticketNumber" },
  { name: "title", descKey: "notifications:generic.fields.title" },
  { name: "projectName", descKey: "notifications:generic.fields.projectName" },
  { name: "message", descKey: "notifications:generic.fields.message" },
  { name: "ticketUrl", descKey: "notifications:generic.fields.ticketUrl" },
  { name: "source", descKey: "notifications:generic.fields.source" },
  { name: "prUrl", descKey: "notifications:generic.fields.prUrl" },
  { name: "costUsd", descKey: "notifications:generic.fields.costUsd" },
  { name: "type", descKey: "notifications:generic.fields.type" },
  { name: "effort", descKey: "notifications:generic.fields.effort" },
  { name: "error", descKey: "notifications:generic.fields.error" },
];

/** Passi numerati per ottenere il webhook Slack. */
function SlackGuide() {
  const { t } = useTranslation();
  return (
    <ol className="list-decimal space-y-1.5 pl-5 font-mono text-[12px] text-fg-muted">
      <li>
        {t("notifications:slack.step1Prefix")}{" "}
        <a
          href="https://api.slack.com/apps"
          target="_blank"
          rel="noreferrer"
          className="text-signal underline-offset-2 hover:underline"
        >
          api.slack.com/apps
        </a>
        {t("notifications:slack.step1Suffix")}
      </li>
      <li>
        <Trans i18nKey="notifications:slack.step2" components={{ create: <span className="text-fg" /> }} />
      </li>
      <li>
        <Trans i18nKey="notifications:slack.step3" components={{ webhooks: <span className="text-fg" /> }} />
      </li>
      <li>
        <Trans i18nKey="notifications:slack.step4" components={{ add: <span className="text-fg" /> }} />
      </li>
      <li>
        <Trans i18nKey="notifications:slack.step5" components={{ url: <span className="text-fg" /> }} />
      </li>
    </ol>
  );
}

/** Passi numerati per ottenere il webhook di un canale Discord. */
function DiscordGuide() {
  return (
    <ol className="list-decimal space-y-1.5 pl-5 font-mono text-[12px] text-fg-muted">
      <li>
        <Trans i18nKey="notifications:discord.step1" components={{ settings: <span className="text-fg" /> }} />
      </li>
      <li>
        <Trans
          i18nKey="notifications:discord.step2"
          components={{ integrations: <span className="text-fg" />, webhook: <span className="text-fg" /> }}
        />
      </li>
      <li>
        <Trans i18nKey="notifications:discord.step3" components={{ new: <span className="text-fg" /> }} />
      </li>
      <li>
        <Trans i18nKey="notifications:discord.step4" components={{ copy: <span className="text-fg" /> }} />
      </li>
      <li>
        <Trans i18nKey="notifications:discord.step5" />
      </li>
    </ol>
  );
}

/** Contratto del payload generico, con elenco campi e link alla documentazione. */
function GenericGuide() {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 font-mono text-[12px] text-fg-muted">
      <p>
        <Trans
          i18nKey="notifications:generic.intro"
          components={{ method: <span className="text-fg" />, ct: <span className="text-fg" /> }}
        />
      </p>
      <dl className="space-y-1">
        {GENERIC_FIELDS.map((field) => (
          <div key={field.name} className="flex flex-wrap gap-x-2">
            <dt className="text-signal">{field.name}</dt>
            <dd className="text-fg-faint">— {t(field.descKey)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** La guida "Come configurare" giusta per il formato selezionato. */
function SetupGuide({ format }: { format: NotificationFormat }) {
  const { t } = useTranslation();
  return (
    <CollapsibleSection title={t("notifications:setupTitle")}>
      {format === "slack" && <SlackGuide />}
      {format === "discord" && <DiscordGuide />}
      {format === "generic" && <GenericGuide />}
      <a
        href="/guide/notifications/"
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-block font-mono text-[12px] text-signal underline-offset-2 hover:underline"
      >
        {t("notifications:viewDocs")}
      </a>
    </CollapsibleSection>
  );
}

/**
 * Anteprima dal vivo del messaggio/payload effettivo: usa `formatNotification`
 * (la stessa funzione del dispatch reale) su un evento d'esempio. Per
 * Slack/Discord mostra il testo/markdown che verrà inviato in un box stile chat;
 * per il formato generico fa il pretty-print del JSON che l'endpoint riceverà.
 */
function LivePreview({
  format,
  contentLanguage,
}: {
  format: NotificationFormat;
  contentLanguage: Language;
}) {
  const { t } = useTranslation();
  // I link dell'anteprima puntano all'istanza corrente (origin del browser).
  const origin = typeof window !== "undefined" ? window.location.origin : "https://stubwise.example.com";
  const samples = useMemo(() => sampleEvents(origin), [origin]);

  // Parte dall'evento "PR aperta": è il più ricco (PR + costo).
  const [selectedKind, setSelectedKind] = useState<NotificationEvent["kind"]>("job.pr_opened");
  const event = samples.find((sample) => sample.kind === selectedKind) ?? samples[0]!;

  // Usa la lingua dei contenuti d'istanza: l'anteprima mostra esattamente ciò
  // che le notifiche reali produrranno (formatNotification è la stessa funzione
  // del dispatch, che già usa la content language).
  const formatted = formatNotification(event, format, contentLanguage);
  const messageText =
    format === "slack"
      ? String((formatted.body as { text: string }).text)
      : format === "discord"
        ? String((formatted.body as { content: string }).content)
        : JSON.stringify(formatted.body, null, 2);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
          {t("notifications:preview")}
        </span>
        <div className="flex flex-wrap gap-1">
          {SAMPLE_LABELS.map((sample) => {
            const active = sample.kind === selectedKind;
            return (
              <button
                key={sample.kind}
                type="button"
                onClick={() => setSelectedKind(sample.kind)}
                aria-pressed={active}
                className={`rounded-sm border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                  active
                    ? "border-signal-dim/50 text-signal"
                    : "border-line-strong text-fg-faint hover:border-ink-700 hover:text-fg-muted"
                }`}
              >
                {t(sample.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      {format === "generic" ? (
        <pre
          data-testid="notification-preview"
          className="overflow-x-auto rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre text-fg"
        >
          {messageText}
        </pre>
      ) : (
        <div
          data-testid="notification-preview"
          className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-fg"
        >
          {messageText}
        </div>
      )}
    </div>
  );
}

/**
 * Sezione Notifiche (solo admin): configura il webhook in uscita (Slack /
 * Discord / JSON generico). Master switch, URL, formato e toggle per-evento;
 * una guida "Come configurare" e un'anteprima dal vivo del messaggio cambiano
 * col formato selezionato. Un Save persiste tutto via PUT, e "Invia notifica di
 * test" verifica il webhook mostrando l'esito inline.
 */
export function NotificationsSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settings } = useSuspenseQuery(notificationSettingsQueryOptions);
  const { data: instance } = useSuspenseQuery(instanceSettingsQueryOptions);

  const [form, setForm] = useState<NotificationSettings>(settings);
  useEffect(() => {
    setForm(settings);
  }, [settings]);

  // Budget mensile: stringa controllata (input numerico) inizializzata dallo
  // stato d'istanza. Stringa vuota = nessun budget (null).
  const [budgetInput, setBudgetInput] = useState<string>(
    instance.monthlyBudgetUsd != null ? String(instance.monthlyBudgetUsd) : "",
  );
  useEffect(() => {
    setBudgetInput(instance.monthlyBudgetUsd != null ? String(instance.monthlyBudgetUsd) : "");
  }, [instance.monthlyBudgetUsd]);

  // Esito dell'ultimo test (ok/errore), mostrato inline finché non si rilancia.
  const [testResult, setTestResult] = useState<TestNotificationResult | null>(null);

  const saveMutation = useMutation({
    mutationFn: (next: NotificationSettings) => putNotificationSettings(next),
    onSuccess: (updated) => {
      queryClient.setQueryData(notificationSettingsQueryOptions.queryKey, updated);
    },
  });

  // Impostazioni d'istanza (lingua dei contenuti + budget mensile): il PUT del
  // server riscrive sempre entrambi i campi, quindi ogni salvataggio invia lo
  // stato completo (il campo non toccato resta quello correntemente in cache).
  const instanceMutation = useMutation({
    mutationFn: (next: InstanceSettingsPatch) => putInstanceSettings(next),
    onSuccess: (updated) => {
      queryClient.setQueryData(instanceSettingsQueryOptions.queryKey, updated);
    },
  });

  const testMutation = useMutation({
    mutationFn: () => postTestNotification(),
    onSuccess: (result) => setTestResult(result),
  });

  // Aggiorna un campo del form; un salvataggio già confermato va "consumato"
  // appena l'utente ritocca qualcosa.
  const update = <K extends keyof NotificationSettings>(
    key: K,
    value: NotificationSettings[K],
  ): void => {
    setForm((current) => ({ ...current, [key]: value }));
    if (saveMutation.isSuccess) saveMutation.reset();
  };

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
            {t("notifications:title")}
          </h2>
          <a
            href="/guide/notifications/"
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-signal underline-offset-2 hover:underline"
          >
            {t("notifications:viewDocs")}
          </a>
        </div>
        <p className="mt-1 font-mono text-[11px] text-fg-faint">{t("notifications:subtitle")}</p>
      </header>

      <div className="space-y-4 px-4 py-4">
        <label className="flex items-center gap-2 font-mono text-[12px] text-fg-muted">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={saveMutation.isPending}
            onChange={(event) => update("enabled", event.target.checked)}
            className="size-4 accent-signal"
            aria-label={t("notifications:enabled")}
          />
          {t("notifications:enabled")}
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
            {t("notifications:contentLanguage")}
          </span>
          <select
            value={instance.contentLanguage}
            disabled={instanceMutation.isPending}
            onChange={(event) =>
              instanceMutation.mutate({
                contentLanguage: event.target.value as Language,
                monthlyBudgetUsd: instance.monthlyBudgetUsd,
              })
            }
            aria-label={t("notifications:contentLanguage")}
            className="w-fit rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="en">{t("notifications:contentLanguageEnglish")}</option>
            <option value="it">{t("notifications:contentLanguageItalian")}</option>
          </select>
          <span className="font-mono text-[11px] text-fg-faint">
            {t("notifications:contentLanguageHint")}
          </span>
        </label>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="instance-monthly-budget"
            className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase"
          >
            {t("notifications:monthlyBudget")}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="instance-monthly-budget"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={budgetInput}
              disabled={instanceMutation.isPending}
              onChange={(event) => setBudgetInput(event.target.value)}
              placeholder={t("notifications:monthlyBudgetPlaceholder")}
              className="w-32 rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="button"
              disabled={instanceMutation.isPending}
              onClick={() => {
                // Vuoto → null (nessun budget); altrimenti numero parsato con
                // guardia su NaN → null.
                const parsed = budgetInput === "" ? null : Number(budgetInput);
                instanceMutation.mutate({
                  contentLanguage: instance.contentLanguage,
                  monthlyBudgetUsd: parsed === null || Number.isNaN(parsed) ? null : parsed,
                });
              }}
              className="rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[12px] font-medium tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t("notifications:monthlyBudgetSave")}
            </button>
          </div>
          <span className="font-mono text-[11px] text-fg-faint">
            {t("notifications:monthlyBudgetHint")}
          </span>
        </div>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
            {t("notifications:format")}
          </span>
          <select
            value={form.format}
            disabled={saveMutation.isPending}
            onChange={(event) => update("format", event.target.value as NotificationFormat)}
            aria-label={t("notifications:format")}
            className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
          >
            {FORMAT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.literal ?? t(option.labelKey!)}
              </option>
            ))}
          </select>
        </label>

        <SetupGuide format={form.format} />

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
            {t("notifications:webhookUrl")}
          </span>
          <input
            type="url"
            value={form.webhookUrl ?? ""}
            disabled={saveMutation.isPending}
            onChange={(event) =>
              update("webhookUrl", event.target.value === "" ? null : event.target.value)
            }
            placeholder={URL_PLACEHOLDER[form.format]}
            aria-label={t("notifications:webhookUrl")}
            className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
          />
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
            {t("notifications:events")}
          </legend>
          {EVENT_TOGGLES.map((toggle) => {
            const label = t(toggle.labelKey);
            return (
              <label
                key={toggle.key}
                className="flex items-center gap-2 font-mono text-[12px] text-fg-muted"
              >
                <input
                  type="checkbox"
                  checked={Boolean(form[toggle.key])}
                  disabled={saveMutation.isPending}
                  onChange={(event) => update(toggle.key, event.target.checked)}
                  className="size-4 accent-signal"
                  aria-label={label}
                />
                {label}
              </label>
            );
          })}
        </fieldset>

        <LivePreview format={form.format} contentLanguage={instance.contentLanguage} />
      </div>

      <footer className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
        <button
          type="button"
          disabled={saveMutation.isPending}
          onClick={() => saveMutation.mutate(form)}
          className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim"
        >
          {saveMutation.isPending ? t("notifications:saving") : t("notifications:save")}
        </button>
        <button
          type="button"
          disabled={testMutation.isPending}
          onClick={() => testMutation.mutate()}
          className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
        >
          {testMutation.isPending ? t("notifications:sending") : t("notifications:sendTest")}
        </button>
        {saveMutation.isSuccess && (
          <span role="status" className="font-mono text-[12px] text-ok">
            {t("notifications:saved")}
          </span>
        )}
        {saveMutation.isError && (
          <span role="alert" className="font-mono text-[12px] text-danger">
            {saveMutation.error.message}
          </span>
        )}
        {testResult && (
          <span
            role={testResult.ok ? "status" : "alert"}
            className={`font-mono text-[12px] ${testResult.ok ? "text-ok" : "text-danger"}`}
          >
            {testResult.detail}
          </span>
        )}
      </footer>
    </section>
  );
}
