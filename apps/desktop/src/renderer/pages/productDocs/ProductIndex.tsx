import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { WithWho } from "../../components/InstanceBlock";
import { SentenceWithWho } from "../../components/WhoCanLink";
import { useAiBlock, useProductFirstVersion } from "../../data/queries";
import { flattenTree } from "../../domain/productDocs/tree";
import { formatDate } from "../../notifications/time";
import { PlusIcon } from "../task/parts";
import { secondaryButton } from "../tasks/controls";
import { DocCode, DocsGroup, rowLinkClass } from "../docs/parts";
import { ReadOnlyLine } from "./ReadOnlyLine";
import { FirstVersionDialog } from "./claude/FirstVersionDialog";
import { ClaudeRing, FirstVersionProgress } from "./claude/FirstVersionProgress";
import {
  firstVersionWayFreshKey,
  indexFreshKey,
  productPageLink,
  takeFresh,
  useCreateAndOpen,
  usePersonName,
  useProductSpaceContext,
} from "./parts";

// L'indice dello spazio Prodotto (shape product-space.md §3.4, §3.6): h1
// «Product», la meta, «New page» per chi scrive, RECENTLY UPDATED e ALL
// PAGES (l'albero rientrato, per chi arriva col cassetto chiuso). Vuoto:
// le strade per chi scrive, una frase per chi legge.

/** Al più 4 livelli di rientro: oltre, la profondità resta nella lettura del nodo. */
const MAX_INDENT = 4;

export function ProductIndex() {
  const { t, i18n } = useTranslation();
  const { project, space, reveal } = useProductSpaceContext();
  const nameOf = usePersonName();
  const create = useCreateAndOpen(project, reveal);
  const edit = space.permissions.edit;
  const latest = space.recent[0];
  const all = flattenTree(space.tree);
  const heading = useRef<HTMLHeadingElement>(null);
  // Dopo l'eliminazione di una radice dalla barra, sotto i 1200: il fuoco qui.
  useEffect(() => {
    if (takeFresh(indexFreshKey(project.code))) heading.current?.focus();
  }, [project.code]);

  // La prima versione di Claude (11b, Task 11, [PQ 6]–[PQ 8]). Mentre scrive
  // l'indice è l'avanzamento, per tutti; finita (o interrotta), lo resta solo
  // per chi l'ha vista scrivere in questa visita: dalla successiva l'indice
  // torna normale.
  const firstVersion = useProductFirstVersion(project.id).data ?? null;
  const [witnessed, setWitnessed] = useState(false);
  if (firstVersion?.status === "writing" && !witnessed) setWitnessed(true);
  const progress =
    firstVersion && (firstVersion.status === "writing" || (witnessed && firstVersion.status === "done"))
      ? firstVersion
      : null;
  const [dialog, setDialog] = useState(false);
  const [focusProgress, setFocusProgress] = useState(false);
  const way = useRef<HTMLButtonElement>(null);
  // Dopo «Undo the first version»: il fuoco sulla prima strada dell'indice
  // vuoto, appena c'è. La lettura dello spazio può arrivare un giro dopo
  // l'indirizzo (l'indice monta ancora con le pagine): finché la strada non
  // c'è il segno resta, e la conferma resta aperta col fuoco (la chiude lo
  // spazio quando il segno è preso), quindi il fuoco non passa dal body.
  const showsWays = !progress && space.pageCount === 0;
  // L'avanzamento se n'è andato col fuoco dentro (annullata da un altro): il
  // fuoco è passato all'h1, e va alla prima strada appena c'è (fix round 1, M4).
  const progressLeft = useRef(false);
  const onProgressLeft = useCallback(() => {
    heading.current?.focus();
    progressLeft.current = true;
  }, []);
  useLayoutEffect(() => {
    if (!showsWays || !way.current) return;
    const fresh = takeFresh(firstVersionWayFreshKey(project.code));
    if (fresh || progressLeft.current) way.current.focus();
    progressLeft.current = false;
  }, [project.code, showsWays]);
  // Chiusa la finestra il fuoco torna alla prima strada (lo fa il dialogo);
  // se la strada non c'è più (una prima versione partita nel frattempo, una
  // pagina comparsa) va al titolo, prima che il dialogo smonti.
  const closeDialog = () => {
    if (!way.current?.isConnected) heading.current?.focus();
    setDialog(false);
  };
  const onStarted = useCallback(() => {
    setWitnessed(true);
    setFocusProgress(true);
  }, []);
  // Il titolo dell'avanzamento ha il fuoco: ora la finestra può chiudersi.
  const onProgressFocused = useCallback(() => {
    setFocusProgress(false);
    setDialog(false);
  }, []);

  return (
    <article className="event-enter mx-auto flex w-full max-w-[720px] flex-col">
      <header className="flex items-start gap-4 pt-8">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold text-ink outline-none">
            {t("productDocs.space.title")}
          </h1>
          {/* Vuoto, la meta tace: lo dice già «No product pages yet» qui sotto. */}
          {latest && (
            <p className="num text-sm text-ink-muted">
              {t("productDocs.space.meta", {
                count: space.pageCount,
                date: formatDate(latest.updatedAt, i18n.language),
                name: nameOf(latest.updatedById),
              })}
            </p>
          )}
        </div>
        {edit && space.pageCount > 0 && (
          <button
            type="button"
            disabled={create.isPending}
            onClick={() => void create.run(null)}
            className={`${secondaryButton} disabled:opacity-60`}
          >
            <PlusIcon />
            {t("productDocs.space.newPage")}
          </button>
        )}
      </header>
      {/* Uno spazio vuoto non ha niente da leggere né da chiedere: niente riga. */}
      {!edit && space.pageCount > 0 && (
        <div className="mt-3">
          <ReadOnlyLine projectId={project.id} projectCode={project.code} scope="index" />
        </div>
      )}

      {progress ? (
        <FirstVersionProgress
          view={progress}
          projectCode={project.code}
          focusRequest={focusProgress}
          onFocused={onProgressFocused}
          onLeaveWithFocus={onProgressLeft}
        />
      ) : space.pageCount === 0 ? (
        <EmptySpace
          edit={edit}
          projectId={project.id}
          projectCode={project.code}
          pending={create.isPending}
          onStart={() => void create.run(null)}
          way={way}
          onFirstVersion={() => setDialog(true)}
        />
      ) : (
        <>
          <DocsGroup title={t("productDocs.space.recent")}>
            <ul aria-label={t("productDocs.space.recent")} className="border-t border-rule">
              {space.recent.map((page) => (
                <li key={page.id}>
                  <Link {...productPageLink(project.code, page.code)} className={rowLinkClass}>
                    <DocCode code={page.code} />
                    <span className="min-w-0 flex-1 truncate text-md text-ink" title={page.title}>
                      {page.title}
                    </span>
                    <span className="num shrink-0 text-xs text-ink-faint">
                      {nameOf(page.updatedById)} · {formatDate(page.updatedAt, i18n.language)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </DocsGroup>
          <DocsGroup title={t("productDocs.space.allPages")} count={space.pageCount}>
            <ul aria-label={t("productDocs.space.allPages")} className="border-t border-rule">
              {all.map(({ page, depth }) => (
                <li key={page.id}>
                  <Link
                    {...productPageLink(project.code, page.code)}
                    style={{ paddingLeft: 8 + Math.min(depth, MAX_INDENT) * 16 }}
                    className="flex min-h-8 min-w-0 items-center gap-3 border-b border-rule py-1 pr-2 text-left outline-none transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
                  >
                    <DocCode code={page.code} />
                    <span className="min-w-0 flex-1 truncate text-md text-ink" title={page.title}>
                      {page.title}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </DocsGroup>
        </>
      )}
      {dialog && <FirstVersionDialog project={project} onClose={closeDialog} onStarted={onStarted} />}
    </article>
  );
}

/**
 * Lo spazio vuoto ([PS 15], [PQ 6]): chi scrive ha le strade (righe da 44
 * px, non card), per prima «Write the first version with Claude», poi «Start
 * from a blank page». Chi legge soltanto ha la frase e la sola prima strada,
 * spenta, col perché e il «Who?»: lì c'è qualcosa da chiedere a qualcuno.
 * Col budget del mese finito la prima strada è spenta con la frase del
 * budget; la pausa della coda non la ferma (P48). Spenta resta raggiungibile
 * (`aria-disabled`); il permesso lo dice la vista dello spazio.
 */
function EmptySpace({
  edit,
  projectId,
  projectCode,
  pending,
  onStart,
  way,
  onFirstVersion,
}: {
  edit: boolean;
  projectId: string;
  projectCode: string;
  pending: boolean;
  onStart: () => void;
  way: RefObject<HTMLButtonElement | null>;
  onFirstVersion: () => void;
}) {
  const { t } = useTranslation();
  const budgetOut = useAiBlock(projectId).data?.reason === "monthly_budget";
  const whyId = useId();
  const off = !edit || budgetOut;
  return (
    <section className="flex flex-col gap-2 pt-10">
      <h2 className="text-xl font-semibold text-ink">{t("productDocs.space.emptyTitle")}</h2>
      <p className="max-w-[62ch] text-md text-pretty text-ink-muted">
        {edit ? t("productDocs.space.emptyWrite") : t("productDocs.space.emptyRead")}
      </p>
      <ul aria-label={t("productDocs.space.ways")} className="mt-4 border-t border-rule">
        <li className="flex flex-col border-b border-rule">
          <button
            ref={way}
            type="button"
            aria-disabled={off || undefined}
            aria-describedby={off ? whyId : undefined}
            onClick={() => !off && onFirstVersion()}
            className={`${rowLinkClass} w-full border-b-0 aria-disabled:cursor-default aria-disabled:hover:bg-transparent`}
          >
            <span className="flex h-5 shrink-0 items-center self-start">
              <ClaudeRing size={16} pulse={false} />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className={`text-md font-medium ${off ? "text-ink-muted" : "text-ink"}`}>
                {t("productDocs.firstVersion.way")}
              </span>
              {/* Fra due elementi flessibili lo spazio non si vede: separa il nome dalla frase. */}{" "}
              {!off && (
                <span className="text-xs text-pretty text-ink-muted">{t("productDocs.firstVersion.wayHint")}</span>
              )}
            </span>
          </button>
          {off && (
            // La frase al posto della descrizione, fuori dal bottone: il suo «Who?» è un bottone a sé.
            <p id={whyId} className="-mt-2 pr-2 pb-2 pl-9 text-xs text-pretty text-ink-muted">
              {!edit ? (
                <SentenceWithWho
                  text={t("productDocs.firstVersion.wayReadOnly", { code: projectCode })}
                  action="editDocs"
                  projectId={projectId}
                  projectCode={projectCode}
                />
              ) : (
                <WithWho text={t("claude.panel.budget")} />
              )}
            </p>
          )}
        </li>
        {edit && (
          <li>
            <button
              type="button"
              disabled={pending}
              onClick={onStart}
              className={`${rowLinkClass} w-full text-md font-medium text-ink disabled:opacity-60`}
            >
              <PlusIcon />
              {t("productDocs.space.startBlank")}
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}
