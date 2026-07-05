import type { WidgetUpsertBody } from "@stubwise/shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { createWidget, deleteWidget, updateWidget, type Widget } from "../lib/api";
import { widgetsQueryOptions } from "../lib/queries";
import { translateApiError } from "../lib/translate-api-error";
import { CopyButton } from "./copy-button";

/** Riepilogo di un repository del progetto, per la checklist delle fonti. */
interface RepositoryOption {
  id: string;
  name: string;
  slug: string;
}

interface WidgetsSectionProps {
  projectId: string;
  /** Repository del progetto (fonti selezionabili per il retrieval della chat). */
  repositories: RepositoryOption[];
  /** Slug del progetto: entra nel DSN (`…@host/p/<slug>`). */
  slug: string;
  /** Le scritture sono solo admin: ai member la sezione è in sola lettura. */
  isAdmin: boolean;
}

/**
 * Valori di partenza dell'editor di un widget NUOVO: name vuoto da compilare, il
 * resto ai default dello schema shared (gemelli di `widgetUpsertBodySchema`).
 */
const NEW_WIDGET_FORM: WidgetUpsertBody = {
  name: "",
  enabled: false,
  enabledRepositoryIds: [],
  title: "Assistenza",
  welcomeMessage: "Ciao! Come posso aiutarti?",
  accentColor: "#22c55e",
  language: "it",
  dailyMessageCap: null,
  dailyTicketCap: null,
  repositoryFilters: {},
};

/** Proiezione di un widget salvato verso il form dell'editor (scarta i campi di sola lettura). */
function widgetToForm(widget: Widget): WidgetUpsertBody {
  return {
    name: widget.name,
    enabled: widget.enabled,
    enabledRepositoryIds: widget.enabledRepositoryIds,
    title: widget.title,
    welcomeMessage: widget.welcomeMessage,
    accentColor: widget.accentColor,
    language: widget.language,
    dailyMessageCap: widget.dailyMessageCap,
    dailyTicketCap: widget.dailyTicketCap,
    repositoryFilters: {},
  };
}

/**
 * Snippet di integrazione del widget: carica `/widget.js` (servito da caddy) e
 * inizializza la chat con il DSN al ready. Il DSN porta la CHIAVE DEL WIDGET
 * (non la ingestionKey del progetto). Gli USER_* sono placeholder che il sito
 * ospite sostituisce con l'identità dell'utente loggato.
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
 * Sezione "Widget di assistenza" del dettaglio progetto: un progetto può avere
 * più widget di chat incorporabile, ognuno con la sua chiave, config e cap. La
 * sezione è una lista di card (nome, stato, conteggio conversazioni) più un
 * editor inline per il widget selezionato o per uno nuovo. Le scritture
 * (create/update/delete) sono solo admin; ai member la sezione è in sola
 * lettura (lista visibile, editor coi campi disabilitati e senza bottoni di
 * scrittura).
 */
export function WidgetsSection({ projectId, repositories, slug, isAdmin }: WidgetsSectionProps) {
  const { t } = useTranslation();
  const { data } = useSuspenseQuery(widgetsQueryOptions(projectId));
  const widgets = data.widgets;

  // Editor: `null` = chiuso; { widget } = modifica di un esistente; { widget: null } = nuovo.
  const [editing, setEditing] = useState<{ widget: Widget | null } | null>(null);

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
            {t("widget:title")}
          </h2>
          <p className="mt-1 font-mono text-[11px] text-fg-faint">{t("widget:subtitle")}</p>
        </div>
        {isAdmin && editing === null && (
          <button
            type="button"
            onClick={() => setEditing({ widget: null })}
            className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim"
          >
            {t("widget:newWidget")}
          </button>
        )}
      </header>

      <div className="space-y-3 px-4 py-4">
        {widgets.length === 0 && editing === null ? (
          <p className="font-mono text-[12px] text-fg-faint">{t("widget:empty")}</p>
        ) : (
          widgets.map((widget) => (
            <div
              key={widget.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-line bg-ink-950/70 px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-[13px] text-fg">{widget.name}</span>
                <span
                  className={`rounded-sm px-1.5 py-0.5 font-mono text-[10px] tracking-[0.14em] uppercase ${
                    widget.enabled ? "bg-ok/15 text-ok" : "bg-ink-800 text-fg-faint"
                  }`}
                >
                  {widget.enabled ? t("widget:statusEnabled") : t("widget:statusDisabled")}
                </span>
                <span className="font-mono text-[11px] text-fg-faint">
                  {t("widget:conversationCount", { count: widget.conversationCount })}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setEditing({ widget })}
                className="rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg"
              >
                {t("widget:edit")}
              </button>
            </div>
          ))
        )}

        {editing !== null && (
          <WidgetEditor
            key={editing.widget?.id ?? "new"}
            projectId={projectId}
            repositories={repositories}
            slug={slug}
            isAdmin={isAdmin}
            widget={editing.widget}
            onClose={() => setEditing(null)}
          />
        )}
      </div>
    </section>
  );
}

interface WidgetEditorProps {
  projectId: string;
  repositories: RepositoryOption[];
  slug: string;
  isAdmin: boolean;
  /** Widget da modificare, o `null` per un nuovo widget. */
  widget: Widget | null;
  onClose: () => void;
}

/**
 * Editor inline di un widget: nome, toggle attivazione, checklist delle fonti
 * (con warning se abilitato senza fonti), title/welcome/accent/language, i due
 * cap giornalieri (vuoto = default d'istanza) e — per un widget già salvato —
 * lo snippet precompilato con la sua CHIAVE e il bottone elimina (conferma
 * due-step). Salva via POST (nuovo) o PUT (esistente).
 */
function WidgetEditor({
  projectId,
  repositories,
  slug,
  isAdmin,
  widget,
  onClose,
}: WidgetEditorProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [form, setForm] = useState<WidgetUpsertBody>(
    widget ? widgetToForm(widget) : NEW_WIDGET_FORM,
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const saveMutation = useMutation({
    mutationFn: (next: WidgetUpsertBody) =>
      widget ? updateWidget(projectId, widget.id, next) : createWidget(projectId, next),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: widgetsQueryOptions(projectId).queryKey });
      onClose();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!widget) throw new Error("delete su un widget non ancora salvato");
      return deleteWidget(projectId, widget.id);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: widgetsQueryOptions(projectId).queryKey });
      onClose();
    },
  });

  const update = <K extends keyof WidgetUpsertBody>(key: K, value: WidgetUpsertBody[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
    if (saveMutation.isError) saveMutation.reset();
  };

  const toggleRepository = (id: string, checked: boolean): void => {
    update(
      "enabledRepositoryIds",
      checked
        ? [...form.enabledRepositoryIds, id]
        : form.enabledRepositoryIds.filter((existing) => existing !== id),
    );
  };

  // Cap: input vuoto → null (default d'istanza); un numero valido → intero.
  const updateCap = (key: "dailyMessageCap" | "dailyTicketCap", raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      update(key, null);
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    update(key, Number.isNaN(parsed) ? null : parsed);
  };

  const busy = saveMutation.isPending || deleteMutation.isPending;
  const disabled = !isAdmin || busy;
  const showEmptyWarning = form.enabled && form.enabledRepositoryIds.length === 0;

  // Lo snippet appare solo per un widget già salvato (serve la sua `key`).
  const url = new URL(window.location.origin);
  const snippet = widget
    ? buildSnippet(`${url.protocol}//${widget.key}@${url.host}/p/${slug}`, url.origin)
    : null;

  return (
    <div className="space-y-4 rounded-sm border border-line-strong bg-ink-950/50 px-4 py-4">
      <label className="flex flex-col gap-1">
        <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
          {t("widget:name")}
        </span>
        <input
          type="text"
          value={form.name}
          disabled={disabled}
          onChange={(event) => update("name", event.target.value)}
          aria-label={t("widget:name")}
          className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim disabled:cursor-not-allowed disabled:opacity-60"
        />
      </label>

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
          onChange={(event) =>
            update("language", event.target.value as WidgetUpsertBody["language"])
          }
          aria-label={t("widget:language")}
          className="w-fit rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim disabled:cursor-not-allowed disabled:opacity-60"
        >
          <option value="it">{t("widget:languageItalian")}</option>
          <option value="en">{t("widget:languageEnglish")}</option>
        </select>
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
            {t("widget:dailyMessageCap")}
          </span>
          <input
            type="number"
            min={1}
            value={form.dailyMessageCap ?? ""}
            disabled={disabled}
            onChange={(event) => updateCap("dailyMessageCap", event.target.value)}
            placeholder={t("widget:dailyMessageCapPlaceholder")}
            aria-label={t("widget:dailyMessageCap")}
            className="w-32 rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
            {t("widget:dailyTicketCap")}
          </span>
          <input
            type="number"
            min={1}
            value={form.dailyTicketCap ?? ""}
            disabled={disabled}
            onChange={(event) => updateCap("dailyTicketCap", event.target.value)}
            placeholder={t("widget:dailyTicketCapPlaceholder")}
            aria-label={t("widget:dailyTicketCap")}
            className="w-32 rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
      </div>

      {snippet && (
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
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
        {isAdmin ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => saveMutation.mutate(form)}
              className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim"
            >
              {saveMutation.isPending ? t("widget:saving") : t("widget:save")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg disabled:opacity-50"
            >
              {t("widget:cancel")}
            </button>
            {saveMutation.isError && (
              <span role="alert" className="font-mono text-[12px] text-danger">
                {translateApiError(saveMutation.error, t)}
              </span>
            )}
          </>
        ) : (
          <>
            <p className="font-mono text-[11px] text-fg-faint">{t("widget:readOnlyHint")}</p>
            <button
              type="button"
              onClick={onClose}
              className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
            >
              {t("widget:close")}
            </button>
          </>
        )}
      </div>

      {isAdmin && widget && (
        <div className="border-t border-danger/30 pt-3">
          {confirmingDelete ? (
            <div className="flex flex-col gap-3 rounded-sm border border-danger/30 bg-danger/10 px-3 py-3">
              <p className="font-mono text-[11px] text-danger">{t("widget:deleteConfirm")}</p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => deleteMutation.mutate()}
                  className="rounded-sm border border-danger/40 px-3 py-2 font-mono text-[12px] tracking-[0.08em] text-danger uppercase transition-colors hover:bg-danger/20 disabled:opacity-50"
                >
                  {deleteMutation.isPending ? t("widget:deleting") : t("widget:deleteConfirmYes")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmingDelete(false)}
                  className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg disabled:opacity-50"
                >
                  {t("widget:cancel")}
                </button>
              </div>
              {deleteMutation.isError && (
                <span role="alert" className="font-mono text-[12px] text-danger">
                  {translateApiError(deleteMutation.error, t)}
                </span>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="rounded-sm border border-danger/30 px-3 py-2 font-mono text-[12px] tracking-[0.08em] text-danger uppercase transition-colors hover:bg-danger/10"
            >
              {t("widget:delete")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
