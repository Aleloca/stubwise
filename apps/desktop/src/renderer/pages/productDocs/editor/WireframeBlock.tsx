import { useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAiBlock, useKeepWireframe, useRedrawWireframe } from "../../../data/queries";
import type { ProductBlock, ProductPageView } from "../../../data/types";
import { WithWho } from "../../../components/InstanceBlock";
import { WhoCanLink } from "../../../components/WhoCanLink";
import { ClaudeRing } from "../claude/FirstVersionProgress";

// La bozza di schermata di Claude (11b, Task 12; shape
// product-claude-backlog.md §3.5, [PB 6], [PB 8]): un blocco a tutta colonna
// come l'immagine, bordo 1 px `rule`, raggio 8, fondo `surface`. Finché
// nessuno la tiene ha la testata «Claude's draft · Screen sketch» con
// l'anello fermo: è il suo segno (nessun segno a margine). Lo schizzo è
// l'SVG del seme (`page.wireframes`, le pagine non leggono il seme), linee in
// `currentColor` = `ink`: bianco e nero in entrambi i temi.
//
// Per chi scrive, al passaggio o al fuoco: «Keep» (toglie l'etichetta, da lì
// è una figura come le altre; maintainer 6 nov 2026), «Redraw» (la variante
// seguente, sul posto; il fuoco resta su «Redraw») e «Replace with an image»
// (la scelta del file è dell'editor, che mette l'immagine al posto del
// blocco). Chi legge soltanto vede l'etichetta e lo schizzo, nessun bottone.
// Un doppio clic fa una sola scrittura: `inFlight` qui, e `fromVariant` /
// «già tenuta» nel livello dati.

type Wireframe = Extract<ProductBlock, { type: "wireframe" }>;

/** Ciò che chi scrive chiede all'editor. */
export interface WireframeEditing {
  /** «Replace with an image»: la scelta del file, poi l'immagine al posto del blocco. */
  replace(): void;
  /** «New sketch», «Kept · …»: l'annuncio della pagina. */
  announce(text: string): void;
}

/** I disegni del seme col loro nome tradotto; gli altri sono «uno schizzo di una schermata». */
const NAMED = new Set(["booking", "membership", "bills", "sign-in", "screen"]);

const textButton =
  "inline-flex h-6 shrink-0 items-center rounded-[4px] px-1.5 text-xs font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-disabled:cursor-default aria-disabled:text-ink-faint aria-disabled:hover:bg-transparent aria-disabled:hover:text-ink-faint";

export function WireframeBlock({
  block,
  page,
  projectId,
  projectCode,
  editing,
  onSelect,
}: {
  block: Wireframe;
  page: ProductPageView;
  projectId: string;
  projectCode: string;
  /** Solo per chi scrive. */
  editing?: WireframeEditing;
  /** Un clic sullo schizzo (non su un bottone) sceglie il blocco come oggetto. */
  onSelect?: () => void;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLElement>(null);
  const labelId = useId();
  const svg = page.wireframes?.[`${block.wireframeId}:${block.variant}`] ?? null;
  const kept = block.kept === true;
  const screen = t(`productDocs.wireframe.screens.${NAMED.has(block.wireframeId) ? block.wireframeId : "screen"}`);
  const name = kept
    ? t("productDocs.wireframe.nameKept", { screen })
    : t("productDocs.wireframe.nameDraft", { screen });

  const redraw = useRedrawWireframe();
  const keep = useKeepWireframe();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<"redraw" | "keep" | null>(null);
  const [failed, setFailed] = useState<"redraw" | "keep" | null>(null);
  const [keepForbidden, setKeepForbidden] = useState(false);
  /** Dopo «Keep» il fuoco va al blocco, scelto come oggetto ([PE 5]). */
  const focusAfterKeep = useRef(false);
  // «Redraw» è un gesto di Claude: col budget del mese finito è spenta con la
  // sua frase e il «Who?», come «/» e «⋯» (§3.6). «Keep» e «Replace» no.
  const budgetOut = useAiBlock(projectId).data?.reason === "monthly_budget";
  /**
   * Il gesto che aveva il fuoco e che il prossimo disegno può rimontare
   * altrove (fix round 1, I1): «Redraw» dopo «Keep» rimette la testata, e i
   * bottoni passano dall'angolo in alto alla testata. Il fuoco segue il gesto.
   */
  const restoreAction = useRef<"redraw" | "keep" | null>(null);

  // «Keep» se ne va nello stesso disegno in cui l'etichetta sparisce: il
  // fuoco passa al blocco prima che il browser lo lasci sul body.
  useLayoutEffect(() => {
    if (!kept || !focusAfterKeep.current) return;
    focusAfterKeep.current = false;
    root.current?.closest<HTMLElement>("[data-block-id]")?.focus();
  }, [kept]);

  // Il gesto rimontato altrove (o la riga del Riprova tolta): il fuoco torna
  // sul suo bottone nello stesso disegno, mai sul body.
  useLayoutEffect(() => {
    const kind = restoreAction.current;
    if (!kind) return;
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected;
    if (lost) {
      const target = root.current?.querySelector<HTMLElement>(`[data-sketch-action="${kind}"]`);
      if (target) {
        target.focus();
        return;
      }
    }
    // Il gesto è finito e il fuoco sta bene: niente più da seguire.
    if (!busy && !lost) restoreAction.current = null;
  });

  const run = (kind: "redraw" | "keep") => {
    if (!editing || inFlight.current) return;
    inFlight.current = true;
    setBusy(kind);
    setFailed(null);
    if (kind === "keep") focusAfterKeep.current = !!root.current?.contains(document.activeElement);
    if (kind === "redraw" && root.current?.contains(document.activeElement)) restoreAction.current = "redraw";
    const done =
      kind === "redraw"
        ? redraw.mutateAsync({ pageId: page.id, blockId: block.id, fromVariant: block.variant }).then(() => {
            editing.announce(t("productDocs.wireframe.newSketch"));
          })
        : keep.mutateAsync({ pageId: page.id, blockId: block.id }).then(() => {
            editing.announce(t("productDocs.wireframe.kept"));
          });
    done
      .catch((error: unknown) => {
        if (kind === "keep") focusAfterKeep.current = false;
        if (kind === "keep" && (error as { message?: string } | null)?.message === "forbidden") setKeepForbidden(true);
        else setFailed(kind);
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(null);
      });
  };

  const select = (e: MouseEvent) => {
    if (!onSelect || (e.target as Element).closest("a,button")) return;
    e.preventDefault();
    onSelect();
  };

  const canKeep = !kept && svg !== null;
  /** «Riprova»: prima il fuoco sul gesto (che resta, in corso), poi la riga se ne va (fix round 1, I2). */
  const retry = (kind: "redraw" | "keep") => {
    root.current?.querySelector<HTMLElement>(`[data-sketch-action="${kind}"]`)?.focus();
    restoreAction.current = kind === "redraw" ? "redraw" : null;
    run(kind);
  };
  const actions = editing ? (
    <div
      role="group"
      aria-label={t("productDocs.wireframe.actions")}
      className={`flex flex-wrap items-center gap-0.5 transition-opacity duration-[var(--duration-fast)] ease-out ${
        busy || failed || keepForbidden || budgetOut
          ? ""
          : "opacity-0 group-focus-within/block:opacity-100 group-hover/block:opacity-100"
      }`}
    >
      {canKeep && busy !== "redraw" && (
        <button
          type="button"
          data-sketch-action="keep"
          aria-disabled={busy === "keep" || keepForbidden || undefined}
          aria-describedby={keepForbidden ? `${labelId}-keep` : undefined}
          onClick={() => !keepForbidden && run("keep")}
          className={textButton}
        >
          {busy === "keep" ? t("productDocs.wireframe.keeping") : t("productDocs.wireframe.keep")}
        </button>
      )}
      {busy !== "keep" && (
        <button
          type="button"
          data-sketch-action="redraw"
          aria-disabled={busy === "redraw" || budgetOut || undefined}
          aria-describedby={budgetOut ? `${labelId}-budget` : undefined}
          onClick={() => !budgetOut && run("redraw")}
          className={textButton}
        >
          {busy === "redraw" ? t("productDocs.wireframe.redrawing") : t("productDocs.wireframe.redraw")}
        </button>
      )}
      {!busy && (
        <button type="button" onClick={() => editing.replace()} className={textButton}>
          {t("productDocs.wireframe.replace")}
        </button>
      )}
    </div>
  ) : null;

  return (
    <figure
      ref={root}
      aria-labelledby={kept ? undefined : labelId}
      className="relative flex flex-col overflow-hidden rounded-lg border border-rule bg-surface"
    >
      {!kept && (
        <figcaption className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-b border-rule py-1 pr-1.5 pl-3 text-xs">
          <span id={labelId} className="flex min-w-0 items-center gap-1.5">
            <ClaudeRing size={12} pulse={busy === "redraw"} />
            <span className="font-semibold text-ink">{t("productDocs.wireframe.label")}</span>{" "}
            <span className="text-ink-muted">· {t("productDocs.wireframe.kind")}</span>
          </span>
          {actions}
        </figcaption>
      )}
      {budgetOut && editing && (
        <p id={`${labelId}-budget`} className="border-b border-rule px-3 py-1.5 text-xs text-pretty text-ink-muted">
          <WithWho text={t("productDocs.wireframe.budget")} />
        </p>
      )}
      {keepForbidden && (
        <p id={`${labelId}-keep`} className="border-b border-rule px-3 py-1.5 text-xs text-pretty text-ink-muted">
          {t("productDocs.wireframe.keepForbidden", { code: projectCode })}
          <span aria-hidden="true"> · </span>
          <WhoCanLink action="editDocs" projectId={projectId} projectCode={projectCode} />
        </p>
      )}
      {/* Tenuta, i gesti stanno in alto a destra dentro il bordo: lo schizzo scende sotto di loro. */}
      <div onMouseDown={select} className={`relative p-4 ${kept && actions ? "pt-9" : ""}`}>
        {kept && actions && <div className="absolute top-1.5 right-1.5 z-10">{actions}</div>}
        {svg !== null ? (
          <div
            key={`${block.wireframeId}:${block.variant}`}
            role="img"
            aria-label={name}
            // Lo schizzo è del seme (`PRODUCT_WIREFRAMES`): SVG fissi in `currentColor`, nessun dato di chi scrive.
            dangerouslySetInnerHTML={{ __html: svg }}
            className="event-enter mx-auto flex max-h-[328px] w-full justify-center text-ink [&>svg]:h-auto [&>svg]:max-h-[328px] [&>svg]:w-full [&>svg]:max-w-[492px]"
          />
        ) : (
          <p className="flex h-32 items-center justify-center text-[13px] text-ink-muted">{t("productDocs.wireframe.gone")}</p>
        )}
      </div>
      {failed && (
        <p role="alert" className="flex flex-wrap items-center gap-x-1.5 border-t border-rule px-3 py-1.5 text-xs text-critical">
          <span>{failed === "redraw" ? t("productDocs.wireframe.redrawFailed") : t("productDocs.wireframe.keepFailed")}</span>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={() => retry(failed)} className="font-medium underline underline-offset-2">
            {t("productDocs.wireframe.retry")}
          </button>
        </p>
      )}
    </figure>
  );
}

/**
 * Il posto della bozza mentre Claude disegna (§3.6): la stessa forma, alta
 * 160, con l'anello che pulsa e «Claude is sketching…». Con movimento ridotto
 * l'anello è fermo e la parola porta lo stato.
 */
export function SketchingPlaceholder() {
  const { t } = useTranslation();
  return (
    <div
      data-sketching=""
      className="flex h-40 items-center justify-center gap-2 rounded-lg border border-rule bg-surface text-[13px] text-ink-muted"
    >
      <ClaudeRing size={12} pulse />
      <span>{t("productDocs.wireframe.sketching")}</span>
    </div>
  );
}
