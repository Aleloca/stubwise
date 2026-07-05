import type { WidgetSettings } from "@stubwise/shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { putWidgetSettings } from "../lib/api";
import { widgetSettingsQueryOptions } from "../lib/queries";
import { translateApiError } from "../lib/translate-api-error";
import { CopyButton } from "./copy-button";

/** Riepilogo di un repository del progetto, per la checklist delle fonti. */
interface RepositoryOption {
  id: string;
  name: string;
  slug: string;
}

interface WidgetSettingsSectionProps {
  projectId: string;
  /** Repository del progetto (fonti selezionabili per il retrieval della chat). */
  repositories: RepositoryOption[];
  /** Chiave di ingestion del progetto: entra nel DSN dello snippet. */
  ingestionKey: string;
  /** Slug del progetto: entra nel DSN (`…@host/p/<slug>`). */
  slug: string;
  /** Il PUT è solo admin: ai member la sezione è in sola lettura (submit nascosto). */
  isAdmin: boolean;
}

/**
 * Snippet di integrazione del widget: carica `/widget.js` (servito da caddy) e
 * inizializza la chat con il DSN del progetto al ready. Gli USER_* sono
 * placeholder che il sito ospite sostituisce con l'identità dell'utente loggato.
 */
function buildSnippet(dsn: string, origin: string): string {
  return [
    `<script src="${origin}/widget.js" defer></script>`,
    "<script>",
    '  window.addEventListener("stubwise:ready", function () {',
    "    Stubwise.initWidget({",
    `      dsn: "${dsn}",`,
    '      user: { id: "USER_ID", email: "USER_EMAIL", name: "USER_NAME" },',
    "    });",
    "  });",
    "</script>",
  ].join("\n");
}

/**
 * Sezione "Widget di assistenza" del dettaglio progetto: configura la chat
 * incorporabile che risponde dai Docs del progetto e può aprire un ticket.
 * Toggle di attivazione, checklist dei repository che alimentano il retrieval
 * (con warning se abilitato senza fonti), titolo, messaggio di benvenuto,
 * colore d'accento e lingua. Salvataggio via PUT (solo admin: ai member i campi
 * sono disabilitati e il Save è nascosto). In fondo lo snippet pronto da
 * incollare, con DSN e chiave di ingestion del progetto.
 */
export function WidgetSettingsSection({
  projectId,
  repositories,
  ingestionKey,
  slug,
  isAdmin,
}: WidgetSettingsSectionProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settings } = useSuspenseQuery(widgetSettingsQueryOptions(projectId));

  const [form, setForm] = useState<WidgetSettings>(settings);
  useEffect(() => {
    setForm(settings);
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: (next: WidgetSettings) => putWidgetSettings(projectId, next),
    onSuccess: (updated) => {
      queryClient.setQueryData(widgetSettingsQueryOptions(projectId).queryKey, updated);
    },
  });

  // Aggiorna un campo del form; un salvataggio già confermato va "consumato"
  // appena l'utente ritocca qualcosa (come in NotificationsSection).
  const update = <K extends keyof WidgetSettings>(key: K, value: WidgetSettings[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
    if (saveMutation.isSuccess) saveMutation.reset();
  };

  const toggleRepository = (id: string, checked: boolean): void => {
    update(
      "enabledRepositoryIds",
      checked
        ? [...form.enabledRepositoryIds, id]
        : form.enabledRepositoryIds.filter((existing) => existing !== id),
    );
  };

  const url = new URL(window.location.origin);
  const dsn = `${url.protocol}//${ingestionKey}@${url.host}/p/${slug}`;
  const snippet = buildSnippet(dsn, url.origin);

  const disabled = !isAdmin || saveMutation.isPending;
  const showEmptyWarning = form.enabled && form.enabledRepositoryIds.length === 0;

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          {t("widget:title")}
        </h2>
        <p className="mt-1 font-mono text-[11px] text-fg-faint">{t("widget:subtitle")}</p>
      </header>

      <div className="space-y-4 px-4 py-4">
        <label className="flex items-center gap-2 font-mono text-[12px] text-fg-muted">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={disabled}
            onChange={(event) => update("enabled", event.target.checked)}
            className="size-4 accent-signal"
            aria-label={t("widget:enabled")}
          />
          {t("widget:enabled")}
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
            {t("widget:sources")}
          </legend>
          {repositories.length === 0 ? (
            <p className="font-mono text-[12px] text-fg-faint">{t("widget:noRepositories")}</p>
          ) : (
            repositories.map((repository) => (
              <label
                key={repository.id}
                className="flex items-center gap-2 font-mono text-[12px] text-fg-muted"
              >
                <input
                  type="checkbox"
                  checked={form.enabledRepositoryIds.includes(repository.id)}
                  disabled={disabled}
                  onChange={(event) => toggleRepository(repository.id, event.target.checked)}
                  className="size-4 accent-signal"
                  aria-label={repository.name}
                />
                <span className="text-fg">{repository.name}</span>
                <span className="text-fg-faint">{repository.slug}</span>
              </label>
            ))
          )}
          <span className="font-mono text-[11px] text-fg-faint">{t("widget:sourcesHint")}</span>
          {showEmptyWarning && (
            <p role="alert" className="font-mono text-[11px] text-danger">
              {t("widget:emptySourcesWarning")}
            </p>
          )}
        </fieldset>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
            {t("widget:displayTitle")}
          </span>
          <input
            type="text"
            value={form.title}
            disabled={disabled}
            onChange={(event) => update("title", event.target.value)}
            aria-label={t("widget:displayTitle")}
            className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
            {t("widget:welcomeMessage")}
          </span>
          <textarea
            value={form.welcomeMessage}
            disabled={disabled}
            rows={3}
            onChange={(event) => update("welcomeMessage", event.target.value)}
            aria-label={t("widget:welcomeMessage")}
            className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>

        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
            {t("widget:accentColor")}
          </span>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={form.accentColor}
              disabled={disabled}
              onChange={(event) => update("accentColor", event.target.value)}
              aria-label={t("widget:accentColor")}
              className="h-8 w-10 rounded-sm border border-line-strong bg-ink-950/70 disabled:cursor-not-allowed disabled:opacity-60"
            />
            <input
              type="text"
              value={form.accentColor}
              disabled={disabled}
              onChange={(event) => update("accentColor", event.target.value)}
              aria-label={`${t("widget:accentColor")} (hex)`}
              className="w-28 rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>
        </div>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
            {t("widget:language")}
          </span>
          <select
            value={form.language}
            disabled={disabled}
            onChange={(event) => update("language", event.target.value as WidgetSettings["language"])}
            aria-label={t("widget:language")}
            className="w-fit rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="it">{t("widget:languageItalian")}</option>
            <option value="en">{t("widget:languageEnglish")}</option>
          </select>
        </label>

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
              {t("widget:snippet")}
            </span>
            <CopyButton text={snippet} label={t("widget:copySnippet")} />
          </div>
          <pre
            data-testid="widget-snippet"
            className="overflow-x-auto rounded-sm border border-line bg-ink-950/70 p-3 font-mono text-[12px] leading-relaxed text-fg"
          >
            <code>{snippet}</code>
          </pre>
          <p className="mt-2 font-mono text-[11px] text-fg-faint">{t("widget:snippetHint")}</p>
        </div>
      </div>

      {isAdmin ? (
        <footer className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
          <button
            type="button"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate(form)}
            className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim"
          >
            {saveMutation.isPending ? t("widget:saving") : t("widget:save")}
          </button>
          {saveMutation.isSuccess && (
            <span role="status" className="font-mono text-[12px] text-ok">
              {t("widget:saved")}
            </span>
          )}
          {saveMutation.isError && (
            <span role="alert" className="font-mono text-[12px] text-danger">
              {translateApiError(saveMutation.error, t)}
            </span>
          )}
        </footer>
      ) : (
        <footer className="border-t border-line px-4 py-3">
          <p className="font-mono text-[11px] text-fg-faint">{t("widget:readOnlyHint")}</p>
        </footer>
      )}
    </section>
  );
}
