import { EFFORT_LABELS, ticketTypeSchema, type TicketType } from "@stubwise/shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { TypeBadge } from "../components/badges";
import { GitAccountsSection } from "../components/git-accounts-section";
import {
  postTestNotification,
  putAutomationSettings,
  putNotificationSettings,
  type AutomationRule,
  type NotificationFormat,
  type NotificationSettings,
  type TestNotificationResult,
} from "../lib/api";
import { meQueryOptions } from "../lib/auth";
import {
  automationSettingsQueryOptions,
  notificationSettingsQueryOptions,
} from "../lib/queries";

/**
 * Impostazioni: dati dell'account corrente e, per gli admin, le regole di
 * automazione AI per tipo di ticket (auto-fix on/off + soglia di sforzo).
 * La gestione degli accessi (membri e inviti) vive nella pagina Team.
 */
export function SettingsPage() {
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";

  return (
    <div className="p-8">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-fg-muted">Il tuo account e l'automazione AI.</p>
      </header>

      <div className="mt-6 grid items-start gap-8 lg:grid-cols-2">
        <section className="rounded-sm border border-line bg-ink-900">
          <header className="border-b border-line px-4 py-3">
            <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
              Account
            </h2>
          </header>
          <dl className="space-y-3 px-4 py-4">
            <div className="flex flex-col gap-1">
              <dt className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
                Email
              </dt>
              <dd className="font-mono text-[13px] text-fg">{me.user.email}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
                Ruolo
              </dt>
              <dd>
                <span
                  className={`inline-flex rounded-sm border px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] uppercase ${
                    isAdmin
                      ? "border-signal-dim/40 text-signal"
                      : "border-line-strong text-fg-muted"
                  }`}
                >
                  {isAdmin ? "Admin" : "Member"}
                </span>
              </dd>
            </div>
          </dl>
        </section>

        {isAdmin && <AutomationSection />}
        {isAdmin && <NotificationsSection />}
        {isAdmin && <GitAccountsSection />}
      </div>
    </div>
  );
}

/** Etichetta "Medio (3/5)" per un valore di sforzo. */
function effortOptionLabel(value: number): string {
  return `${EFFORT_LABELS[value] ?? value} (${value}/5)`;
}

/**
 * Sezione Automazione AI (solo admin): una riga per ciascuno dei 4 tipi di
 * ticket con il toggle auto-fix e la soglia di sforzo. Un solo Save persiste
 * tutte le regole via PUT; lo stato locale parte dai dati del server.
 */
function AutomationSection() {
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
    setRules((current) =>
      current.map((r) => (r.type === type ? { ...r, ...patch } : r)),
    );
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
                  onChange={(event) =>
                    updateRule(type, { maxEffort: Number(event.target.value) })
                  }
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

/**
 * Sezione Notifiche (solo admin): configura il webhook in uscita (Slack /
 * Discord / JSON generico). Master switch, URL, formato e toggle per-evento;
 * un Save persiste tutto via PUT, e "Invia notifica di test" verifica il
 * webhook mostrando l'esito inline. Stato locale inizializzato dal server.
 */
function NotificationsSection() {
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
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          Notifiche
        </h2>
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
            URL webhook
          </span>
          <input
            type="url"
            value={form.webhookUrl ?? ""}
            disabled={saveMutation.isPending}
            onChange={(event) =>
              update("webhookUrl", event.target.value === "" ? null : event.target.value)
            }
            placeholder="https://hooks.slack.com/services/…"
            aria-label="URL webhook"
            className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
          />
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
