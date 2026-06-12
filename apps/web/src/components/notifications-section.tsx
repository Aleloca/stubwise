import {
  formatNotification,
  sampleEvents,
  type NotificationEvent,
} from "@stubwise/notifications/format";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  postTestNotification,
  putNotificationSettings,
  type NotificationFormat,
  type NotificationSettings,
  type TestNotificationResult,
} from "../lib/api";
import { notificationSettingsQueryOptions } from "../lib/queries";
import { CollapsibleSection } from "./collapsible-section";

/** Le opzioni di formato del webhook, con etichetta leggibile. */
const FORMAT_OPTIONS: { value: NotificationFormat; label: string }[] = [
  { value: "slack", label: "Slack" },
  { value: "discord", label: "Discord" },
  { value: "generic", label: "JSON generico" },
];

/** I toggle per-evento, con etichetta italiana. */
const EVENT_TOGGLES: { key: keyof NotificationSettings; label: string }[] = [
  { key: "notifyTicketCreated", label: "Nuovo ticket SDK" },
  { key: "notifyPrOpened", label: "PR aperta" },
  { key: "notifyJobHeld", label: "In attesa" },
  { key: "notifyJobFailed", label: "Fix fallito" },
];

/** Etichetta leggibile di ciascun evento d'esempio, per il selettore d'anteprima. */
const SAMPLE_LABELS: { kind: NotificationEvent["kind"]; label: string }[] = [
  { kind: "ticket.created", label: "Nuovo ticket" },
  { kind: "job.pr_opened", label: "PR aperta" },
  { kind: "job.held", label: "In attesa" },
  { kind: "job.failed", label: "Fix fallito" },
];

/** Placeholder dell'URL webhook in base al formato selezionato. */
const URL_PLACEHOLDER: Record<NotificationFormat, string> = {
  slack: "https://hooks.slack.com/services/…",
  discord: "https://discord.com/api/webhooks/…",
  generic: "https://example.com/webhooks/stubwise",
};

/** I campi del payload generico, documentati inline. */
const GENERIC_FIELDS: { name: string; desc: string }[] = [
  { name: "event", desc: "il tipo di evento (ticket.created, job.pr_opened, job.held, job.failed)" },
  { name: "ticketNumber", desc: "numero del ticket" },
  { name: "title", desc: "titolo del ticket" },
  { name: "projectName", desc: "nome del progetto" },
  { name: "message", desc: "riepilogo leggibile dell'evento" },
  { name: "ticketUrl", desc: "link al ticket in Stubwise" },
  { name: "source", desc: "solo ticket.created — sorgente SDK (sdk_error / sdk_feedback)" },
  { name: "prUrl", desc: "solo job.pr_opened — URL della pull request" },
  { name: "costUsd", desc: "solo job.pr_opened — costo USD del run (o null)" },
  { name: "type", desc: "solo job.held — tipo del ticket riclassificato" },
  { name: "effort", desc: "solo job.held — sforzo stimato 1–5" },
  { name: "error", desc: "solo job.failed — messaggio d'errore" },
];

/** Passi numerati per ottenere il webhook Slack. */
function SlackGuide() {
  return (
    <ol className="list-decimal space-y-1.5 pl-5 font-mono text-[12px] text-fg-muted">
      <li>
        Vai su{" "}
        <a
          href="https://api.slack.com/apps"
          target="_blank"
          rel="noreferrer"
          className="text-signal underline-offset-2 hover:underline"
        >
          api.slack.com/apps
        </a>
        .
      </li>
      <li>
        Premi <span className="text-fg">Create New App</span> → From scratch, scegli nome e
        workspace.
      </li>
      <li>
        Nel menu laterale apri <span className="text-fg">Incoming Webhooks</span> e attivalo
        (Activate Incoming Webhooks).
      </li>
      <li>
        Premi <span className="text-fg">Add New Webhook to Workspace</span> e scegli il canale di
        destinazione.
      </li>
      <li>
        Copia l'URL generato (<span className="text-fg">https://hooks.slack.com/services/…</span>) e
        incollalo qui sopra.
      </li>
    </ol>
  );
}

/** Passi numerati per ottenere il webhook di un canale Discord. */
function DiscordGuide() {
  return (
    <ol className="list-decimal space-y-1.5 pl-5 font-mono text-[12px] text-fg-muted">
      <li>
        Apri le <span className="text-fg">Impostazioni del canale</span> (l'icona dell'ingranaggio
        accanto al nome del canale).
      </li>
      <li>
        Vai su <span className="text-fg">Integrazioni</span> → <span className="text-fg">Webhook</span>.
      </li>
      <li>
        Premi <span className="text-fg">Nuovo webhook</span> (puoi rinominarlo, es. "Stubwise").
      </li>
      <li>
        Premi <span className="text-fg">Copia URL del webhook</span>.
      </li>
      <li>Incolla l'URL qui sopra.</li>
    </ol>
  );
}

/** Contratto del payload generico, con elenco campi e link alla documentazione. */
function GenericGuide() {
  return (
    <div className="space-y-2 font-mono text-[12px] text-fg-muted">
      <p>
        Il tuo endpoint riceverà una richiesta <span className="text-fg">POST</span> con{" "}
        <span className="text-fg">Content-Type: application/json</span> e questo schema:
      </p>
      <dl className="space-y-1">
        {GENERIC_FIELDS.map((field) => (
          <div key={field.name} className="flex flex-wrap gap-x-2">
            <dt className="text-signal">{field.name}</dt>
            <dd className="text-fg-faint">— {field.desc}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** La guida "Come configurare" giusta per il formato selezionato. */
function SetupGuide({ format }: { format: NotificationFormat }) {
  return (
    <CollapsibleSection title="Come configurare">
      {format === "slack" && <SlackGuide />}
      {format === "discord" && <DiscordGuide />}
      {format === "generic" && <GenericGuide />}
      <a
        href="/docs/notifications/"
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-block font-mono text-[12px] text-signal underline-offset-2 hover:underline"
      >
        Vedi documentazione →
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
function LivePreview({ format }: { format: NotificationFormat }) {
  // I link dell'anteprima puntano all'istanza corrente (origin del browser).
  const origin = typeof window !== "undefined" ? window.location.origin : "https://stubwise.example.com";
  const samples = useMemo(() => sampleEvents(origin), [origin]);

  // Parte dall'evento "PR aperta": è il più ricco (PR + costo).
  const [selectedKind, setSelectedKind] = useState<NotificationEvent["kind"]>("job.pr_opened");
  const event = samples.find((sample) => sample.kind === selectedKind) ?? samples[0]!;

  const formatted = formatNotification(event, format);
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
          Anteprima
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
                {sample.label}
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
  const queryClient = useQueryClient();
  const { data: settings } = useSuspenseQuery(notificationSettingsQueryOptions);

  const [form, setForm] = useState<NotificationSettings>(settings);
  useEffect(() => {
    setForm(settings);
  }, [settings]);

  // Esito dell'ultimo test (ok/errore), mostrato inline finché non si rilancia.
  const [testResult, setTestResult] = useState<TestNotificationResult | null>(null);

  const saveMutation = useMutation({
    mutationFn: (next: NotificationSettings) => putNotificationSettings(next),
    onSuccess: (updated) => {
      queryClient.setQueryData(notificationSettingsQueryOptions.queryKey, updated);
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
            Notifiche
          </h2>
          <a
            href="/docs/notifications/"
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-signal underline-offset-2 hover:underline"
          >
            Vedi documentazione →
          </a>
        </div>
        <p className="mt-1 font-mono text-[11px] text-fg-faint">
          Un webhook in uscita riceve un messaggio sugli eventi chiave (nuovo ticket SDK, PR
          aperta, in attesa, fix fallito).
        </p>
      </header>

      <div className="space-y-4 px-4 py-4">
        <label className="flex items-center gap-2 font-mono text-[12px] text-fg-muted">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={saveMutation.isPending}
            onChange={(event) => update("enabled", event.target.checked)}
            className="size-4 accent-signal"
            aria-label="Abilitate"
          />
          Abilitate
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
            Formato
          </span>
          <select
            value={form.format}
            disabled={saveMutation.isPending}
            onChange={(event) => update("format", event.target.value as NotificationFormat)}
            aria-label="Formato"
            className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
          >
            {FORMAT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <SetupGuide format={form.format} />

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
            URL webhook
          </span>
          <input
            type="url"
            value={form.webhookUrl ?? ""}
            disabled={saveMutation.isPending}
            onChange={(event) =>
              update("webhookUrl", event.target.value === "" ? null : event.target.value)
            }
            placeholder={URL_PLACEHOLDER[form.format]}
            aria-label="URL webhook"
            className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
          />
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
            Eventi
          </legend>
          {EVENT_TOGGLES.map((toggle) => (
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
                aria-label={toggle.label}
              />
              {toggle.label}
            </label>
          ))}
        </fieldset>

        <LivePreview format={form.format} />
      </div>

      <footer className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
        <button
          type="button"
          disabled={saveMutation.isPending}
          onClick={() => saveMutation.mutate(form)}
          className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim"
        >
          {saveMutation.isPending ? "Salvataggio…" : "Salva"}
        </button>
        <button
          type="button"
          disabled={testMutation.isPending}
          onClick={() => testMutation.mutate()}
          className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
        >
          {testMutation.isPending ? "Invio…" : "Invia notifica di test"}
        </button>
        {saveMutation.isSuccess && (
          <span role="status" className="font-mono text-[12px] text-ok">
            Salvato
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
