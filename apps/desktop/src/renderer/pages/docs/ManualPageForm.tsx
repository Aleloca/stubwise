import { Link, Navigate, useBlocker, useNavigate } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCreateManualPage, useDocPage, useUpdateManualPage } from "../../data/queries";
import type { DocPage } from "../../data/types";
import { SLUG_RE, slugify } from "../../domain/docs";
import { inputClass } from "../../tasks-ui/Dialog";
import { Markdown } from "../../tasks-ui/Markdown";
import { PageError } from "../../tasks-ui/PageStates";
import { InlineConfirm } from "../task/parts";
import { primaryButton, secondaryButton } from "../tasks/controls";
import {
  DocNotFound,
  ReadingSkeleton,
  backLinkClass,
  pageLink,
  spaceLink,
  useSpace,
} from "./parts";

// La pagina manuale (shape docs.md §5, A 8): un form a pagina, non un
// dialogo. Title, Slug (facoltativo: viene dal titolo, con l'anteprima di
// dove starà), Body in Markdown con «Write / Preview». Lo slug già usato è
// un errore sul campo. Uscire con modifiche (Cancel, un link, l'albero)
// chiede «Discard your changes?»; cambiare persona lo butta senza chiedere
// (lo spazio si rimonta).

/** «+ New manual page»: solo con `docs.edit`. */
export function NewManualPageRoute() {
  const { project, space } = useSpace();
  if (!space.permissions.edit) return <Navigate {...spaceLink(project.code, space.name)} replace />;
  return <ManualPageForm initial={null} />;
}

/** «Edit» di una pagina manuale; una generata o senza permesso torna alla pagina. */
export function EditManualPageRoute({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const { project, space } = useSpace();
  const page = useDocPage(space.repositoryId, slug);
  if (page.isError) {
    return (
      <div className="pt-6">
        <PageError message={t("docs.page.loadError")} onRetry={() => void page.refetch()} />
      </div>
    );
  }
  if (page.isPending) return <ReadingSkeleton />;
  if (!page.data) {
    return (
      <DocNotFound
        back={
          <Link {...spaceLink(project.code, space.name)} className={backLinkClass}>
            {t("docs.page.backToIndex")}
          </Link>
        }
      />
    );
  }
  if (!page.data.permissions.edit) {
    return <Navigate {...pageLink(project.code, space.name, slug)} replace />;
  }
  return <ManualPageForm key={page.data.id} initial={page.data} />;
}

type Errors = { title?: string; slug?: string; form?: string };

function ManualPageForm({ initial }: { initial: DocPage | null }) {
  const { t } = useTranslation();
  const { project, space } = useSpace();
  const navigate = useNavigate();
  const create = useCreateManualPage();
  const update = useUpdateManualPage();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [errors, setErrors] = useState<Errors>({});
  const ids = { title: useId(), slug: useId(), slugHint: useId(), body: useId() };

  const dirty =
    title !== (initial?.title ?? "") ||
    slug !== (initial?.slug ?? "") ||
    body !== (initial?.body ?? "");
  // Letti al momento della navigazione: dopo il salvataggio si esce senza chiedere.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const saved = useRef(false);
  const blocker = useBlocker({
    shouldBlockFn: () => dirtyRef.current && !saved.current,
    enableBeforeUnload: false,
    withResolver: true,
  });

  const effectiveSlug = slug.trim() || slugify(title);
  const pending = create.isPending || update.isPending;
  const back = initial
    ? pageLink(project.code, space.name, initial.slug)
    : spaceLink(project.code, space.name);

  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    if (message === "slug_conflict") setErrors({ slug: t("docs.form.errors.slugConflict") });
    else if (message.includes("slug")) setErrors({ slug: t("docs.form.errors.slugInvalid") });
    else setErrors({ form: t("docs.form.errors.generic") });
  };
  const done = (page: DocPage) => {
    saved.current = true;
    void navigate({ ...pageLink(project.code, space.name, page.slug), replace: !initial });
  };

  const submit = () => {
    const next: Errors = {};
    if (!title.trim()) next.title = t("docs.form.errors.title");
    if (slug.trim() && !SLUG_RE.test(slug.trim())) next.slug = t("docs.form.errors.slugInvalid");
    else if (!effectiveSlug) next.slug = t("docs.form.errors.slugInvalid");
    setErrors(next);
    if (next.title || next.slug) return;
    if (initial) {
      update.mutate(
        { id: initial.id, patch: { title, slug: effectiveSlug, body } },
        { onSuccess: done, onError: fail },
      );
    } else {
      create.mutate(
        {
          repositoryId: space.repositoryId,
          input: { title, slug: slug.trim() || undefined, body },
        },
        { onSuccess: done, onError: fail },
      );
    }
  };

  const tabClass =
    "inline-flex h-7 items-center rounded-md px-2.5 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-selected:bg-ink/10 aria-selected:text-ink";

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="event-enter flex flex-col gap-5 pt-8"
    >
      <h1 className="text-2xl font-semibold text-balance text-ink">
        {initial ? t("docs.form.editTitle", { title: initial.title }) : t("docs.form.newTitle")}
      </h1>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={ids.title} className="text-sm font-medium text-ink">
          {t("docs.form.title")}
        </label>
        <input
          id={ids.title}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={errors.title ? `${ids.title}-err` : undefined}
          autoFocus
          className={inputClass}
        />
        {errors.title && (
          <p id={`${ids.title}-err`} className="text-sm text-critical">
            {errors.title}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={ids.slug} className="text-sm font-medium text-ink">
          {t("docs.form.slug")}{" "}
          <span className="font-normal text-ink-muted">{t("docs.form.optional")}</span>
        </label>
        <input
          id={ids.slug}
          value={slug}
          placeholder={slugify(title) || undefined}
          onChange={(e) => {
            setSlug(e.target.value);
            if (errors.slug) setErrors((prev) => ({ ...prev, slug: undefined }));
          }}
          aria-invalid={errors.slug ? true : undefined}
          aria-describedby={errors.slug ? `${ids.slug}-err` : ids.slugHint}
          spellCheck={false}
          className={`${inputClass} num`}
        />
        {errors.slug ? (
          <p id={`${ids.slug}-err`} className="text-sm text-critical">
            {errors.slug}
          </p>
        ) : (
          <p id={ids.slugHint} className="truncate text-xs text-ink-faint">
            {effectiveSlug
              ? t("docs.form.willBeAt", { path: `/docs/${space.name}/${effectiveSlug}` })
              : t("docs.form.slugHint")}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <label htmlFor={ids.body} className="text-sm font-medium text-ink">
            {t("docs.form.body")}
          </label>
          <div role="tablist" aria-label={t("docs.form.body")} className="ml-auto flex gap-0.5">
            {(["write", "preview"] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={tabClass}
              >
                {t(`docs.form.${key}`)}
              </button>
            ))}
          </div>
        </div>
        {tab === "write" ? (
          <textarea
            id={ids.body}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={14}
            className={`${inputClass} min-h-60 resize-y leading-relaxed`}
          />
        ) : (
          <div
            role="tabpanel"
            aria-label={t("docs.form.preview")}
            className="min-h-60 rounded-md border border-rule px-3 py-2.5"
          >
            {body.trim() ? (
              <Markdown source={body} documentHeadings />
            ) : (
              <p className="text-md text-ink-faint">{t("docs.form.previewEmpty")}</p>
            )}
          </div>
        )}
      </div>

      {errors.form && (
        <p role="alert" className="text-sm text-critical">
          {errors.form}
        </p>
      )}

      {blocker.status === "blocked" ? (
        <InlineConfirm
          message={t("docs.form.discard")}
          confirm={t("docs.form.discardAction")}
          cancelLabel={t("docs.form.keep")}
          onConfirm={() => blocker.proceed?.()}
          onCancel={() => blocker.reset?.()}
        />
      ) : (
        <div className="flex items-center justify-end gap-2 border-t border-rule pt-4">
          <button type="button" onClick={() => void navigate(back)} className={secondaryButton}>
            {t("docs.form.cancel")}
          </button>
          <button type="submit" disabled={pending} className={primaryButton}>
            {pending ? t("docs.form.saving") : t("docs.form.save")}
          </button>
        </div>
      )}
    </form>
  );
}
