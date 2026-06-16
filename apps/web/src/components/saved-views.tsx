import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { createSavedView, deleteSavedView, type SavedView, type SavedViewFilters } from "../lib/api";
import { savedViewsQueryOptions } from "../lib/queries";
import { translateApiError } from "../lib/translate-api-error";
import { FormError } from "./field";

interface SavedViewsProps {
  /** Filtri attualmente attivi nella lista (derivati dagli URL search param). */
  currentFilters: SavedViewFilters;
  /** Applica una vista: la route scrive ESATTAMENTE questi filtri nell'URL. */
  onApply: (filters: SavedViewFilters) => void;
}

/**
 * Barra delle viste salvate della lista ticket: salva la combinazione di
 * filtri corrente (nome + condivisione opzionale col team), elenca le proprie
 * e quelle condivise dal team, e applica una vista riscrivendo i filtri
 * nell'URL via `onApply`. Le viste altrui condivise sono solo applicabili
 * (niente elimina); le proprie si eliminano con conferma a due click.
 *
 * Vive nella lista ticket: i filtri salvati combaciano con i suoi search
 * param. La board ha un solo filtro (progetto), quindi non la monta.
 */
export function SavedViews({ currentFilters, onApply }: SavedViewsProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: views = [] } = useQuery(savedViewsQueryOptions);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: savedViewsQueryOptions.queryKey });

  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      createSavedView({ name: name.trim(), filters: currentFilters, shared }),
    onSuccess: async () => {
      setName("");
      setShared(false);
      setSaveError(null);
      await invalidate();
    },
    // 409 view_exists → messaggio "nome già esistente" localizzato; ogni altro
    // errore API passa per translateApiError (code → errors:<code>, o message).
    onError: (cause) => setSaveError(translateApiError(cause, t)),
  });

  function handleSave(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "" || createMutation.isPending) return;
    createMutation.mutate();
  }

  return (
    <section className="space-y-3" aria-label={t("savedViews:title")}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase">
          {t("savedViews:title")}
        </h2>

        {views.length === 0 ? (
          <span className="font-mono text-[11px] text-fg-faint">{t("savedViews:empty")}</span>
        ) : (
          <ul className="flex flex-wrap items-center gap-2">
            {views.map((view) => (
              <SavedViewItem
                key={view.id}
                view={view}
                onApply={onApply}
                onChanged={invalidate}
              />
            ))}
          </ul>
        )}
      </div>

      <form onSubmit={handleSave} className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-48 flex-col gap-1">
          <label htmlFor="saved-view-name" className={labelClass}>
            {t("savedViews:name")}
          </label>
          <input
            id="saved-view-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("savedViews:namePlaceholder")}
            className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
          />
        </div>
        <label className="flex items-center gap-2 pb-2 font-mono text-[11px] tracking-[0.1em] text-fg-muted uppercase">
          <input
            type="checkbox"
            checked={shared}
            onChange={(event) => setShared(event.target.checked)}
            className="size-3.5 accent-signal"
          />
          {t("savedViews:share")}
        </label>
        <button
          type="submit"
          disabled={name.trim() === "" || createMutation.isPending}
          className="rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[11px] font-semibold tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          {createMutation.isPending ? t("savedViews:saving") : t("savedViews:save")}
        </button>
      </form>

      <FormError message={saveError} />
    </section>
  );
}

const labelClass = "font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase";

function SavedViewItem({
  view,
  onApply,
  onChanged,
}: {
  view: SavedView;
  onApply: (filters: SavedViewFilters) => void;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => deleteSavedView(view.id),
    onSuccess: () => onChanged(),
  });

  function handleDelete() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    deleteMutation.mutate();
  }

  return (
    <li className="flex items-center gap-1.5 rounded-sm border border-line bg-ink-900 px-2 py-1">
      <button
        type="button"
        // Nome della vista nel label: il test trova "Apply <name>" e la lista
        // resta navigabile da tastiera con un'etichetta parlante.
        aria-label={t("savedViews:apply") + " " + view.name}
        onClick={() => onApply(view.filters)}
        className="font-mono text-[12px] text-fg transition-colors hover:text-signal"
      >
        {view.name}
      </button>

      {view.isOwn
        ? view.shared && (
            <span className="rounded-sm border border-signal-dim/50 px-1 py-px font-mono text-[9px] font-semibold tracking-[0.12em] text-signal uppercase">
              {t("savedViews:shared")}
            </span>
          )
        : (
            <span className="rounded-sm border border-line-strong px-1 py-px font-mono text-[9px] tracking-[0.1em] text-fg-faint uppercase">
              {t("savedViews:ownedBy", { owner: view.ownerId })}
            </span>
          )}

      {view.isOwn && (
        <button
          type="button"
          disabled={deleteMutation.isPending}
          aria-pressed={confirmingDelete}
          onClick={handleDelete}
          onBlur={() => setConfirmingDelete(false)}
          className={`font-mono text-[10px] tracking-[0.1em] uppercase transition-colors ${
            confirmingDelete ? "text-danger" : "text-fg-faint hover:text-danger"
          }`}
        >
          {confirmingDelete ? t("savedViews:confirmDelete") : t("savedViews:delete")}
        </button>
      )}
    </li>
  );
}
