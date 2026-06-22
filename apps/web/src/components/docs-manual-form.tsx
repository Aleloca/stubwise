import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import {
  createManualPage,
  type DocPage,
  type ManualPageDraft,
  type ManualPagePatch,
  updateManualPage,
} from "../lib/docs-api";
import { docsKeys } from "../lib/queries";
import { FormError, SubmitButton, TextField } from "./field";
import { MarkdownEditor } from "./markdown-editor";

/**
 * Form di creazione/modifica di una pagina manuale (M7.3). In modalità "create"
 * mostra anche lo slug opzionale; in "edit" lo slug è immutabile lato server e
 * non si tocca. Riusa `MarkdownEditor` per il corpo e il pattern mutation +
 * `invalidateQueries` (albero + pagina) come il resto dell'app. Su successo
 * naviga alla pagina; `onCancel` torna alla vista precedente senza salvare.
 *
 * Solo le pagine `isManual` arrivano qui: i controlli di Edit/Delete sono
 * gated dal chiamante (`DocsPageView`), così le pagine autogenerate non sono
 * mai editabili.
 */

interface DocsManualFormProps {
  projectId: string;
  /** Pagina da modificare; assente = creazione di una nuova pagina. */
  page?: DocPage;
  onCancel: () => void;
  /**
   * Chiamato dopo il salvataggio riuscito (prima della navigazione): permette
   * al chiamante di uscire dalla modalità di modifica quando la navigazione
   * resta sulla stessa rotta (es. edit inline di una pagina aperta).
   */
  onSaved?: () => void;
}

export function DocsManualForm({ projectId, page, onCancel, onSaved }: DocsManualFormProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isEdit = page !== undefined;

  const [title, setTitle] = useState(page?.title ?? "");
  const [slug, setSlug] = useState("");
  const [body, setBody] = useState(page?.body ?? "");

  const mutation = useMutation({
    mutationFn: async (): Promise<DocPage> => {
      if (isEdit) {
        const patch: ManualPagePatch = { title, body };
        return updateManualPage(projectId, page.id, patch);
      }
      const trimmedSlug = slug.trim();
      const draft: ManualPageDraft = {
        title,
        body,
        ...(trimmedSlug !== "" && { slug: trimmedSlug }),
      };
      return createManualPage(projectId, draft);
    },
    onSuccess: async (saved) => {
      // Albero (nuova/aggiornata pagina) + la pagina stessa devono riconciliarsi.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: docsKeys.tree(projectId) }),
        queryClient.invalidateQueries({ queryKey: docsKeys.page(projectId, saved.slug) }),
      ]);
      // Esce dalla modalità di modifica (la navigazione può restare sulla
      // stessa rotta, che non smonterebbe il form).
      onSaved?.();
      await navigate({
        to: "/docs/$projectId/$slug",
        params: { projectId, slug: saved.slug },
      });
    },
  });

  // 409 sullo slug: messaggio dedicato; altri errori → messaggio del server o fallback.
  const errorMessage =
    mutation.error instanceof ApiError && mutation.error.status === 409
      ? t("docs:manual.slugConflict")
      : mutation.error instanceof Error
        ? mutation.error.message
        : mutation.error
          ? t("docs:manual.error")
          : null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mx-auto flex max-w-3xl flex-col gap-4 p-8"
      noValidate
    >
      <h1 className="text-xl font-semibold">
        {isEdit ? t("docs:manual.editPageTitle") : t("docs:manual.newPageTitle")}
      </h1>

      <TextField
        id="manual-title"
        label={t("docs:manual.title")}
        required
        placeholder={t("docs:manual.titlePlaceholder")}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />

      {!isEdit && (
        <>
          <TextField
            id="manual-slug"
            label={t("docs:manual.slug")}
            placeholder={t("docs:manual.slugPlaceholder")}
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
          />
          <p className="-mt-1 font-mono text-[11px] text-fg-faint">
            {t("docs:manual.slugHint")}
          </p>
        </>
      )}

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="manual-body"
          className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
        >
          {t("docs:manual.body")}
        </label>
        <MarkdownEditor
          id="manual-body"
          value={body}
          onChange={setBody}
          rows={16}
          placeholder={t("docs:manual.bodyPlaceholder")}
          aria-label={t("docs:manual.body")}
        />
      </div>

      <FormError message={errorMessage} />

      <div className="flex items-center gap-2">
        <SubmitButton pending={mutation.isPending} disabled={title.trim() === ""}>
          {mutation.isPending
            ? t("docs:manual.saving")
            : isEdit
              ? t("docs:manual.save")
              : t("docs:manual.create")}
        </SubmitButton>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-sm border border-line-strong px-3 py-2.5 font-mono text-[13px] font-semibold tracking-[0.08em] text-fg-muted uppercase transition-colors hover:text-fg"
        >
          {t("docs:manual.cancel")}
        </button>
      </div>
    </form>
  );
}
