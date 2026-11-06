import { Link } from "@tanstack/react-router";
import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Trans, useTranslation } from "react-i18next";
import { WhoCanLink } from "../../../components/WhoCanLink";
import { useAcceptFirstVersionPage, useProductFirstVersion, useUndoFirstVersion } from "../../../data/queries";
import type { ProductFirstVersionView, ProductUndoView, Project } from "../../../data/types";
import { flattenTree } from "../../../domain/productDocs/tree";
import { Dialog } from "../../../tasks-ui/Dialog";
import { dangerSolidButton, secondaryButton } from "../../tasks/controls";
import { productPageLink, usePersonName, useProductSpaceContext } from "../parts";
import { SourceLine } from "./SourceLine";
import { ClaudeRing } from "./FirstVersionProgress";

// La riga in cima a una pagina della prima versione (11b, Task 11; shape
// product-claude-questions.md §3.6, [PQ 9]): sotto la meta, fra due
// filetti. «First version written by Claude on behalf of Laura Costa», le
// fonti (`SourceLine`, nella forma di chi guarda), e i due gesti: «Accept»
// (solo questa pagina, per tutti) e «Undo the first version» (tutto lo
// spazio, con la conferma). Dopo un tocco «Undo» è spento e la frase sotto
// dice chi ha toccato cosa; il livello dati lo decide (`undo`). Chi legge
// soltanto legge la frase e, sotto, perché non può né accettarla né
// annullarla, col «Who?». Una prima versione interrotta lo dice: non è
// stata scritta tutta. Se la riga se ne va col fuoco dentro (Accept), il
// fuoco passa all'h1 PRIMA che i bottoni smontino: mai sul body.

const smallSecondary =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-rule-strong px-2 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10 aria-disabled:cursor-default aria-disabled:text-ink-muted aria-disabled:hover:bg-transparent";
const criticalText =
  "inline-flex h-7 items-center rounded-md px-2 text-sm font-medium text-critical transition-colors duration-[var(--duration-fast)] ease-out hover:bg-critical/10 aria-disabled:cursor-default aria-disabled:text-ink-faint aria-disabled:hover:bg-transparent";
const linkButton = "font-medium underline underline-offset-2";

export function FirstVersionBanner({
  pageId,
  heading,
}: {
  pageId: string;
  /** L'h1 della pagina: il fuoco dopo «Accept». */
  heading: RefObject<HTMLElement | null>;
}) {
  const { project } = useProductSpaceContext();
  const view = useProductFirstVersion(project.id).data ?? null;
  if (!view || !view.bannerPageIds.includes(pageId)) return null;
  return <Banner view={view} pageId={pageId} heading={heading} project={project} />;
}

function Banner({
  view,
  pageId,
  heading,
  project,
}: {
  view: ProductFirstVersionView;
  pageId: string;
  heading: RefObject<HTMLElement | null>;
  project: Project;
}) {
  const { t } = useTranslation();
  const { marks, askUndoFirstVersion } = useProductSpaceContext();
  const accept = useAcceptFirstVersionPage();
  const inflight = useRef(false);
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLElement>(null);
  const reasonId = useId();

  // La riga se ne va (accettata, o la lettura cambiata) col fuoco dentro: il
  // fuoco va all'h1 prima che il nodo sia tolto (la pulizia del layout
  // gira prima della rimozione del DOM).
  useLayoutEffect(() => {
    const el = root.current;
    return () => {
      if (el && el.contains(document.activeElement)) heading.current?.focus();
    };
  }, [heading]);

  const run = () => {
    if (inflight.current) return;
    inflight.current = true;
    setFailed(false);
    accept.mutateAsync(pageId).then(
      () => marks?.announce(t("productDocs.firstVersion.banner.accepted")),
      () => {
        inflight.current = false;
        setFailed(true);
      },
    );
  };

  const sentence = view.byName
    ? t("productDocs.firstVersion.banner.text", { name: view.byName })
    : t("productDocs.firstVersion.banner.textNobody");
  const written = view.pages.filter((p) => p.state === "written").length;
  const off = view.undo.enabled ? null : view.undo;
  return (
    <section
      ref={root}
      aria-label={t("productDocs.firstVersion.banner.label")}
      data-first-version-banner=""
      className="mt-2 flex flex-col gap-1.5 border-y border-rule py-2 text-sm text-ink"
    >
      <p className="flex items-start gap-2">
        <span className="flex h-5 items-center">
          <ClaudeRing size={12} pulse={false} />
        </span>
        <span className="min-w-0 text-pretty">
          {sentence}
          {view.interrupted && (
            <>
              . {t("productDocs.firstVersion.banner.stopped", { done: written, total: view.pagesTotal })}
            </>
          )}
        </span>
      </p>
      <SourceLine sources={view.sources} className="pl-5" />
      {view.permissions.edit ? (
        <div className="flex flex-col gap-1 pl-5">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <button
              type="button"
              aria-disabled={accept.isPending || undefined}
              onClick={run}
              className={smallSecondary}
            >
              {accept.isPending
                ? t("productDocs.firstVersion.banner.accepting")
                : t("productDocs.firstVersion.banner.accept")}
            </button>
            <button
              type="button"
              aria-disabled={off ? true : undefined}
              aria-describedby={off ? reasonId : undefined}
              onClick={() => !off && askUndoFirstVersion?.()}
              className={criticalText}
            >
              {t("productDocs.firstVersion.banner.undo")}
            </button>
          </div>
          {off && <UndoOff undo={off} id={reasonId} project={project} />}
          {failed && (
            <p role="alert" className="flex flex-wrap items-center gap-x-1.5 text-xs text-critical">
              <span>{t("productDocs.firstVersion.banner.acceptFailed")}</span>
              <span aria-hidden="true">·</span>
              <button type="button" onClick={run} className={linkButton}>
                {t("productDocs.firstVersion.banner.retry")}
              </button>
            </p>
          )}
        </div>
      ) : (
        <p className="pl-5 text-xs leading-4 text-ink-muted">
          {t("productDocs.firstVersion.banner.readOnly", { code: project.code })}{" "}
          <span aria-hidden="true">· </span>
          <WhoCanLink action="editDocs" projectId={project.id} projectCode={project.code} />
        </p>
      )}
    </section>
  );
}

/** Perché «Undo the first version» è spento: chi ha toccato cosa, il nome in grassetto, la pagina che si apre. */
function UndoOff({
  undo,
  id,
  project,
}: {
  undo: Extract<ProductUndoView, { enabled: false }>;
  id: string;
  project: Project;
}) {
  const { t } = useTranslation();
  const nameOf = usePersonName();
  const { space } = useProductSpaceContext();
  const code = undo.pageId ? flattenTree(space.tree).find((n) => n.page.id === undo.pageId)?.page.code : undefined;
  const b = <strong className="font-semibold text-ink" />;
  let text;
  if (undo.reason === "already_undone") {
    text = undo.byId ? (
      <Trans i18nKey="productDocs.firstVersion.banner.touched.undone" values={{ name: nameOf(undo.byId) }} components={{ b }} />
    ) : (
      t("productDocs.firstVersion.banner.touched.undoneNobody")
    );
  } else if (undo.byId && undo.pageTitle && undo.touch) {
    const page = code ? (
      <Link
        {...productPageLink(project.code, code)}
        className="rounded-[3px] text-ink underline decoration-ink/30 underline-offset-2 transition-colors duration-[var(--duration-fast)] ease-out hover:decoration-ink/60"
      />
    ) : (
      <span className="text-ink" />
    );
    text = (
      <Trans
        i18nKey={`productDocs.firstVersion.banner.touched.${undo.touch}`}
        values={{ name: nameOf(undo.byId), page: undo.pageTitle }}
        components={{ b, page }}
      />
    );
  } else {
    text = t("productDocs.firstVersion.banner.touched.nobody");
  }
  return (
    <span id={id} className="text-xs leading-4 text-ink-muted">
      {text}
    </span>
  );
}

/**
 * «Undo the first version?» (§3.6): la conferma, critica. Sta nello spazio,
 * non nella pagina: confermata, le pagine se ne vanno (anche quella su cui
 * si era) e il fuoco deve poter restare qui finché l'indice vuoto non lo
 * prende sulla prima strada. Esc e Cancel lo rendono al bottone (il dialogo
 * lo rimette dov'era).
 */
export function FirstVersionUndoDialog({
  project,
  onClose,
  onUndone,
}: {
  project: Project;
  onClose: () => void;
  /** Annullata: lo spazio torna all'indice; il dialogo resta finché il fuoco non è lì. */
  onUndone: () => void;
}) {
  const { t } = useTranslation();
  const view = useProductFirstVersion(project.id).data ?? null;
  const undo = useUndoFirstVersion();
  const inflight = useRef(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<"refused" | "failed" | null>(null);
  // Il numero di pagine della conferma resta quello letto all'apertura.
  const [count] = useState(() => view?.pages.filter((p) => p.pageId !== null).length ?? 0);

  const confirm = () => {
    if (inflight.current) return;
    inflight.current = true;
    setFailure(null);
    undo.mutateAsync(project.id).then(
      () => {
        setDone(true);
        onUndone();
      },
      (error: unknown) => {
        inflight.current = false;
        setFailure(error instanceof Error && error.message.startsWith("refused") ? "refused" : "failed");
      },
    );
  };
  const busy = undo.isPending || done;
  return (
    <Dialog
      title={t("productDocs.firstVersion.undo.title")}
      description={t("productDocs.firstVersion.undo.body", { count })}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button type="button" onClick={onClose} className={secondaryButton}>
            {failure === "refused" ? t("productDocs.firstVersion.undo.close") : t("productDocs.firstVersion.undo.cancel")}
          </button>
          {failure !== "refused" && (
            <button
              type="button"
              aria-disabled={busy || undefined}
              onClick={confirm}
              className={`${dangerSolidButton} aria-disabled:cursor-default aria-disabled:opacity-60`}
            >
              {busy ? t("productDocs.firstVersion.undo.undoing") : t("productDocs.firstVersion.undo.confirm")}
            </button>
          )}
        </>
      }
    >
      {failure === "refused" ? (
        <p role="alert" className="text-sm text-ink">
          {t("productDocs.firstVersion.undo.refused")}
        </p>
      ) : failure === "failed" ? (
        <p role="alert" className="flex flex-wrap items-center gap-x-1.5 text-sm text-critical">
          <span>{t("productDocs.firstVersion.undo.failed")}</span>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={confirm} className={linkButton}>
            {t("productDocs.firstVersion.undo.retry")}
          </button>
        </p>
      ) : null}
    </Dialog>
  );
}
