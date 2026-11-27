import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { safeWireframeSvg } from "../safeWireframe";
import { useTranslation } from "react-i18next";
import { useAiBlock, useKeepWireframe, useRedrawWireframe } from "../../../data/queries";
import type { ProductBlock, ProductPageView, ProductWireframeFailReason } from "../../../data/types";
import { SentenceWithWho } from "../../../components/WhoCanLink";
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
//
// F6 (shape, «Emendamento F6»): il disegno è asincrono, e la pagina dice lo
// stato di ogni bozza non pronta (`page.wireframeStates`). In disegno: la
// testata sempre (anche tenuta), l'anello che pulsa, «Claude is drawing this
// screen…» al posto dello schizzo, Keep e Redraw spenti, Replace acceso. Non
// riuscita: la frase del motivo, al posto dello schizzo se non ce n'è uno,
// sotto se c'era; Redraw acceso. I bottoni si vedono finché dura.

type Wireframe = Extract<ProductBlock, { type: "wireframe" }>;

/** Ciò che chi scrive chiede all'editor. */
export interface WireframeEditing {
  /** «Replace with an image»: la scelta del file, poi l'immagine al posto del blocco. */
  replace(): void;
  /** «New sketch», «Kept · …»: l'annuncio della pagina. */
  announce(text: string): void;
  /** Un'immagine sta caricando al posto della bozza: «Replace with an image» spento (M6). */
  uploading?: boolean;
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
  const sketchState = page.wireframeStates?.[block.id];
  const drawing = sketchState?.status === "drawing";
  const failure = sketchState?.status === "failed" ? sketchState.reason : null;
  // In disegno lo schizzo di prima non si mostra: torna solo se il disegno nuovo non riesce.
  // Una bozza mai disegnata non ne ha (nel prototipo la chiave è del disegno, non del blocco).
  const neverDrawn = drawing || (sketchState?.status === "failed" && !sketchState.drawn);
  // Ripulito anche qui prima di entrare nel documento (M3 della revisione di sicurezza).
  const svg = neverDrawn ? null : safeWireframeSvg(page.wireframes?.[`${block.wireframeId}:${block.variant}`]);
  const kept = block.kept === true;
  /** La testata c'è finché la bozza non è tenuta, e sempre mentre Claude ci lavora o non c'è riuscito. */
  const withHeader = !kept || sketchState !== undefined;
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
  /**
   * «New sketch» quando lo schizzo nuovo arriva davvero (F6): il «Redraw»
   * risponde subito, il disegno finisce dopo. Ciò che si vedeva al clic.
   */
  const awaitingSketch = useRef<{ variant: number; hadSketch: boolean } | null>(null);
  const svgShown = svg !== null;
  useEffect(() => {
    const waited = awaitingSketch.current;
    if (!waited || drawing) return;
    if (failure !== null) {
      awaitingSketch.current = null;
      return;
    }
    if (block.variant !== waited.variant || (svgShown && !waited.hadSketch)) {
      awaitingSketch.current = null;
      editing?.announce(t("productDocs.wireframe.newSketch"));
    }
  }, [block.variant, drawing, failure, svgShown, editing, t]);

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
    // Finché il disegno non arriva i bottoni possono ancora spostarsi (la testata che torna, F6).
    if (!busy && !lost && !drawing && !awaitingSketch.current) restoreAction.current = null;
  });

  const run = (kind: "redraw" | "keep") => {
    if (!editing || inFlight.current) return;
    inFlight.current = true;
    setBusy(kind);
    setFailed(null);
    if (kind === "keep") focusAfterKeep.current = !!root.current?.contains(document.activeElement);
    if (kind === "redraw" && root.current?.contains(document.activeElement)) restoreAction.current = "redraw";
    if (kind === "redraw") awaitingSketch.current = { variant: block.variant, hadSketch: svg !== null };
    const done =
      kind === "redraw"
        ? redraw.mutateAsync({ pageId: page.id, blockId: block.id, fromVariant: block.variant }).then(() => undefined)
        : keep.mutateAsync({ pageId: page.id, blockId: block.id }).then(() => {
            editing.announce(t("productDocs.wireframe.kept"));
          });
    done
      .catch((error: unknown) => {
        if (kind === "redraw") awaitingSketch.current = null;
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

  // In disegno «Keep» c'è, spento: non c'è ancora niente da tenere (§ F6).
  const canKeep = !kept && (svg !== null || drawing);
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
      // `ml-auto`: a capo (l'italiano è più lungo) le azioni restano a destra,
      // non una seconda riga di testo sotto l'etichetta (revisione Impeccable 1).
      className={`ml-auto flex flex-wrap items-center justify-end gap-0.5 transition-opacity duration-[var(--duration-fast)] ease-out ${
        busy || failed || keepForbidden || budgetOut || sketchState
          ? ""
          : "opacity-0 group-focus-within/block:opacity-100 group-hover/block:opacity-100"
      }`}
    >
      {canKeep && busy !== "redraw" && (
        <button
          type="button"
          data-sketch-action="keep"
          aria-disabled={busy === "keep" || keepForbidden || drawing || undefined}
          aria-describedby={keepForbidden ? `${labelId}-keep` : undefined}
          onClick={() => !keepForbidden && !drawing && run("keep")}
          className={textButton}
        >
          {busy === "keep" ? t("productDocs.wireframe.keeping") : t("productDocs.wireframe.keep")}
        </button>
      )}
      {busy !== "keep" && (
        <button
          type="button"
          data-sketch-action="redraw"
          aria-disabled={busy === "redraw" || budgetOut || drawing || undefined}
          aria-describedby={budgetOut ? `${labelId}-budget` : undefined}
          onClick={() => !budgetOut && !drawing && run("redraw")}
          className={textButton}
        >
          {busy === "redraw" ? t("productDocs.wireframe.redrawing") : t("productDocs.wireframe.redraw")}
        </button>
      )}
      {!busy && (
        <button
          type="button"
          aria-disabled={editing.uploading ? true : undefined}
          onClick={() => !editing.uploading && editing.replace()}
          className={textButton}
        >
          {t("productDocs.wireframe.replace")}
        </button>
      )}
    </div>
  ) : null;

  return (
    <figure
      ref={root}
      aria-labelledby={withHeader ? labelId : undefined}
      className="relative flex flex-col overflow-hidden rounded-lg border border-rule bg-surface"
    >
      {withHeader && (
        <figcaption className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-b border-rule py-1 pr-1.5 pl-3 text-xs">
          <span id={labelId} className="flex min-w-0 items-center gap-1.5">
            <ClaudeRing size={12} pulse={busy === "redraw" || drawing} />
            <span className="font-semibold text-ink">{t("productDocs.wireframe.label")}</span>{" "}
            <span className="text-ink-muted">· {t("productDocs.wireframe.kind")}</span>
          </span>
          {actions}
        </figcaption>
      )}
      {budgetOut && editing && failure !== "budget" && (
        <p id={`${labelId}-budget`} className="border-b border-rule px-3 py-1.5 text-xs text-pretty text-ink-muted">
          <SentenceWithWho text={t("productDocs.wireframe.budget")} action="manageSettings" projectId={null} />
        </p>
      )}
      {keepForbidden && (
        <p id={`${labelId}-keep`} className="border-b border-rule px-3 py-1.5 text-xs text-pretty text-ink-muted">
          <SentenceWithWho
            text={t("productDocs.wireframe.keepForbidden", { code: projectCode })}
            action="editDocs"
            projectId={projectId}
            projectCode={projectCode}
          />
        </p>
      )}
      {/* Tenuta, i gesti stanno in alto a destra dentro il bordo: lo schizzo scende sotto di loro. */}
      <div onMouseDown={select} className={`relative p-4 ${!withHeader && actions ? "pt-9" : ""}`}>
        {!withHeader && actions && <div className="absolute top-1.5 right-1.5 z-10">{actions}</div>}
        {drawing ? (
          <p role="status" className="flex h-32 items-center justify-center text-[13px] text-ink-muted">
            {t("productDocs.wireframe.drawing")}
          </p>
        ) : failure !== null && svg === null ? (
          <SketchFailure
            reason={failure}
            redraw={false}
            whoId={`${labelId}-budget`}
            editing={!!editing}
            className="flex h-32 flex-col items-center justify-center gap-1 text-center"
          />
        ) : svg !== null ? (
          <div
            key={`${block.wireframeId}:${block.variant}`}
            role="img"
            aria-label={name}
            // Già ripulito da `safeWireframeSvg` (l'allowlist di `sanitizeWireframeSvg`).
            dangerouslySetInnerHTML={{ __html: svg }}
            className="event-enter mx-auto flex max-h-[328px] w-full justify-center text-ink [&>svg]:h-auto [&>svg]:max-h-[328px] [&>svg]:w-full [&>svg]:max-w-[492px]"
          />
        ) : (
          <p className="flex h-32 items-center justify-center text-[13px] text-ink-muted">{t("productDocs.wireframe.gone")}</p>
        )}
      </div>
      {failure !== null && svg !== null && (
        <SketchFailure
          reason={failure}
          redraw
          whoId={`${labelId}-budget`}
          editing={!!editing}
          className="flex flex-col gap-0.5 border-t border-rule px-3 py-1.5"
        />
      )}
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
 * Perché Claude non è riuscito a disegnare (F6): la riga 13px `ink` e la
 * frase del motivo 12px `ink-muted`; il budget col «Who?» per chi scrive
 * (chi legge soltanto non ha «Who?»). `role="status"`: arriva da sola.
 */
function SketchFailure({
  reason,
  redraw,
  whoId,
  editing,
  className,
}: {
  reason: ProductWireframeFailReason;
  /** C'era già uno schizzo: «couldn't redraw». */
  redraw: boolean;
  /** L'id della frase del budget, che «Redraw» spento nomina. */
  whoId: string;
  editing: boolean;
  className: string;
}) {
  const { t } = useTranslation();
  return (
    <div role="status" className={className}>
      <p className="text-[13px] text-ink">
        {t(redraw ? "productDocs.wireframe.failedRedraw" : "productDocs.wireframe.failedDraw")}
      </p>{" "}
      <p id={reason === "budget" ? whoId : undefined} className="text-xs text-pretty text-ink-muted">
        {reason === "budget" ? (
          editing ? (
            <SentenceWithWho text={t("productDocs.wireframe.budget")} action="manageSettings" projectId={null} />
          ) : (
            t("productDocs.wireframe.budget")
          )
        ) : (
          t(`productDocs.wireframe.failedReason.${reason}`)
        )}
      </p>
    </div>
  );
}

/**
 * Il posto della bozza mentre Claude disegna (§3.6): la stessa forma, alta
 * 160, con l'anello che pulsa e «Claude is sketching…». Con movimento ridotto
 * l'anello è fermo e la parola porta lo stato.
 */
export function SketchingPlaceholder({ focus = false }: { focus?: boolean }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  // Chiesto dal «⋯» della pagina (revisione Impeccable 7): il fuoco qui,
  // dove arriverà la bozza, con lo stato come nome; non resta in cima.
  useLayoutEffect(() => {
    if (!focus) return;
    ref.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [focus]);
  const label = t("productDocs.wireframe.sketching");
  return (
    <div
      ref={ref}
      data-sketching=""
      role="status"
      aria-label={label}
      tabIndex={-1}
      className="flex h-40 items-center justify-center gap-2 rounded-lg border border-rule bg-surface text-[13px] text-ink-muted"
    >
      <ClaudeRing size={12} pulse />
      <span>{label}</span>
    </div>
  );
}
