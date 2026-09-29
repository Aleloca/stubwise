# Widget trascinabile — piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** la bolla del widget si trascina, si aggancia al bordo sinistro o
destro più vicino, ricorda la posizione in `localStorage` per slug, e il
pannello della chat si apre sempre intero e visibile rispetto a dove sta la
bolla.

**Architecture:** tutta la geometria in funzioni pure (`ui/placement.ts`),
testabili senza DOM. Un hook (`ui/use-draggable-bubble.ts`) gestisce Pointer
Events, stato, resize e persistenza. `WidgetRoot` scrive il risultato come
**variabili CSS** sul root (`--sw-bubble-left/top`, `--sw-panel-left/top/width/height`),
e `styles.ts` le consuma: la media query mobile (`inset: 0`) continua a
vincere senza eccezioni in JS. Design: `docs/plans/2026-09-29-widget-draggable-design.md`.

**Tech Stack:** Preact 10, TypeScript, Vitest + happy-dom. Solo `packages/widget`.

Tutti i comandi vanno lanciati da `packages/widget` nel worktree
`.worktrees/widget-drag`.

---

### Task 1: posizione salvata in `core/storage.ts`

**Files:**
- Modify: `packages/widget/src/core/storage.ts`
- Test: `packages/widget/src/core/storage.test.ts`

**Step 1: test che falliscono** — in fondo a `storage.test.ts` (aggiungere
`getPosition, setPosition` all'import):

```ts
describe("bubble position storage", () => {
  it("null quando non c'è nulla salvato", () => {
    expect(getPosition("acme")).toBeNull();
  });

  it("persiste e rilegge per slug, come JSON sotto la chiave dedicata", () => {
    setPosition("acme", { side: "left", y: 0.4 });
    expect(getPosition("acme")).toEqual({ side: "left", y: 0.4 });
    expect(JSON.parse(localStorage.getItem("stubwise-widget:acme:position")!)).toEqual({
      side: "left",
      y: 0.4,
    });
    expect(getPosition("globex")).toBeNull();
  });

  it.each([
    ["non JSON", "{nope"],
    ["lato sconosciuto", JSON.stringify({ side: "top", y: 0.5 })],
    ["y fuori range", JSON.stringify({ side: "left", y: 1.5 })],
    ["y negativa", JSON.stringify({ side: "left", y: -0.1 })],
    ["y non numerica", JSON.stringify({ side: "left", y: "0.5" })],
    ["null", "null"],
  ])("valore corrotto (%s) → null", (_label, raw) => {
    localStorage.setItem("stubwise-widget:acme:position", raw);
    expect(getPosition("acme")).toBeNull();
  });

  it("getter null e setter no-op se localStorage lancia", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getPosition("acme")).toBeNull();
    expect(() => setPosition("acme", { side: "right", y: 1 })).not.toThrow();
  });
});
```

**Step 2:** `npx vitest run src/core/storage.test.ts` → FAIL (`getPosition` non esportata).

**Step 3: implementazione** — in coda a `storage.ts`:

```ts
/**
 * Posizione della bolla scelta dall'utente trascinandola: il lato a cui è
 * agganciata e il CENTRO verticale come frazione (0–1) dell'altezza del
 * viewport — una frazione e non i pixel, così sopravvive al resize e al cambio
 * di schermo.
 */
export interface BubblePosition {
  side: "left" | "right";
  y: number;
}

function positionKey(slug: string): string {
  return `stubwise-widget:${slug}:position`;
}

/**
 * Posizione salvata per lo slug, o null (assente, storage non accessibile, o
 * valore che non ha la forma attesa: un valore corrotto non deve portare la
 * bolla fuori schermo, quindi si torna al default).
 */
export function getPosition(slug: string): BubblePosition | null {
  try {
    const raw = localStorage.getItem(positionKey(slug));
    if (raw === null) return null;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return null;
    const { side, y } = v as Record<string, unknown>;
    if (side !== "left" && side !== "right") return null;
    if (typeof y !== "number" || !Number.isFinite(y) || y < 0 || y > 1) return null;
    return { side, y };
  } catch {
    return null;
  }
}

/** Salva la posizione per lo slug. No-op se lo storage non è accessibile. */
export function setPosition(slug: string, position: BubblePosition): void {
  try {
    localStorage.setItem(positionKey(slug), JSON.stringify(position));
  } catch {
    // storage non disponibile: la posizione vale fino al reload
  }
}
```

**Step 4:** `npx vitest run src/core/storage.test.ts` → PASS.

**Step 5:** commit `feat(widget): posizione della bolla salvata per slug`.

---

### Task 2: geometria pura in `ui/placement.ts`

**Files:**
- Create: `packages/widget/src/ui/placement.ts`
- Test: `packages/widget/src/ui/placement.test.ts`

Costanti (le stesse misure di oggi in `styles.ts`): `EDGE = 20`,
`BUBBLE = 56`, `GAP = 12`, `PANEL_WIDTH = 380`, `PANEL_MAX_HEIGHT = 600`,
`PANEL_MIN_HEIGHT = 360`, `DRAG_THRESHOLD = 5`.
`DEFAULT_POSITION = { side: "right", y: 1 }`: `y = 1` clampato mette la bolla a
20px dal fondo, cioè esattamente dove sta oggi.

**Step 1: test che falliscono** (`placement.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { bubbleBox, clampBox, DEFAULT_POSITION, placePanel, snapPosition } from "./placement.js";

const VP = { width: 1280, height: 800 };

describe("bubbleBox", () => {
  it("default = in basso a destra a 20px dai bordi, come prima", () => {
    expect(bubbleBox(DEFAULT_POSITION, VP)).toEqual({ left: 1280 - 20 - 56, top: 800 - 20 - 56 });
  });
  it("lato sinistro a 20px; y frazione del centro", () => {
    expect(bubbleBox({ side: "left", y: 0.5 }, VP)).toEqual({ left: 20, top: 400 - 28 });
  });
  it("y agli estremi resta dentro i margini", () => {
    expect(bubbleBox({ side: "left", y: 0 }, VP).top).toBe(20);
    expect(bubbleBox({ side: "left", y: 1 }, { width: 400, height: 300 }).top).toBe(300 - 20 - 56);
  });
});

describe("snapPosition", () => {
  it("centro nella metà sinistra → left, altrimenti right", () => {
    expect(snapPosition(639, 400, VP).side).toBe("left");
    expect(snapPosition(640, 400, VP).side).toBe("right");
  });
  it("y = centro clampato / altezza", () => {
    expect(snapPosition(100, 400, VP).y).toBe(0.5);
    expect(snapPosition(100, -500, VP).y).toBe(48 / 800);
    expect(snapPosition(100, 5000, VP).y).toBe(752 / 800);
  });
});

describe("clampBox", () => {
  it("tiene la bolla trascinata dentro il viewport", () => {
    expect(clampBox({ left: -50, top: -50 }, VP)).toEqual({ left: 0, top: 20 });
    expect(clampBox({ left: 5000, top: 5000 }, VP)).toEqual({ left: 1280 - 56, top: 800 - 20 - 56 });
  });
});

describe("placePanel", () => {
  it("bolla in basso a destra → pannello sopra, allineato a destra, 600 alto", () => {
    const p = placePanel(bubbleBox(DEFAULT_POSITION, VP), VP);
    expect(p).toEqual({ left: 1280 - 20 - 380, top: 724 - 12 - 600, width: 380, height: 600 });
  });
  it("bolla in alto a sinistra → pannello sotto, allineato a sinistra", () => {
    const p = placePanel(bubbleBox({ side: "left", y: 0 }, VP), VP);
    expect(p).toEqual({ left: 20, top: 20 + 56 + 12, width: 380, height: 600 });
  });
  it("spazio sopra sotto i 600 → l'altezza si riduce ma resta ≥ 360", () => {
    const vp = { width: 1280, height: 700 };
    const p = placePanel(bubbleBox(DEFAULT_POSITION, vp), vp);
    // bolla top = 624; spazio sopra = 624 - 12 - 20 = 592
    expect(p.height).toBe(592);
    expect(p.top).toBe(20);
  });
  it("meno di 360 in entrambe le direzioni → pannello DI FIANCO, verso l'interno", () => {
    const vp = { width: 1280, height: 600 };
    const b = bubbleBox({ side: "right", y: 0.5 }, vp); // top 272, spazio sopra 240
    const p = placePanel(b, vp);
    expect(p.left).toBe(1280 - 20 - 56 - 12 - 380);
    expect(p.height).toBe(560);
    expect(p.top).toBe(20);
    // e non copre la bolla
    expect(p.left + p.width).toBeLessThanOrEqual(b.left);
  });
  it("di fianco a sinistra → parte dopo la bolla", () => {
    const vp = { width: 1280, height: 600 };
    const p = placePanel(bubbleBox({ side: "left", y: 0.5 }, vp), vp);
    expect(p.left).toBe(20 + 56 + 12);
  });
  it("viewport stretto → larghezza ridotta, mai fuori schermo", () => {
    const vp = { width: 400, height: 800 };
    const p = placePanel(bubbleBox(DEFAULT_POSITION, vp), vp);
    expect(p.width).toBe(360);
    expect(p.left).toBe(20);
  });
});
```

**Step 2:** `npx vitest run src/ui/placement.test.ts` → FAIL (modulo mancante).

**Step 3: implementazione** (`placement.ts`):

```ts
/**
 * Geometria del widget: dove sta la bolla e dove si apre il pannello. Tutte
 * funzioni PURE su numeri (viewport e box in px, coordinate `left`/`top` di un
 * elemento `position: fixed`), così la regola si testa senza DOM. Il widget le
 * applica come variabili CSS: vedi `styles.ts`.
 */
import type { BubblePosition } from "../core/storage.js";

export const EDGE = 20;
export const BUBBLE = 56;
export const GAP = 12;
export const PANEL_WIDTH = 380;
export const PANEL_MAX_HEIGHT = 600;
/** Sotto questa altezza disponibile il pannello non si apre sopra/sotto ma di fianco. */
export const PANEL_MIN_HEIGHT = 360;
/** Spostamento (px) oltre il quale un pointerdown è un trascinamento e non un click. */
export const DRAG_THRESHOLD = 5;

/** Default: in basso a destra (y = 1, clampato a 20px dal fondo), come prima del trascinamento. */
export const DEFAULT_POSITION: BubblePosition = { side: "right", y: 1 };

export interface Viewport { width: number; height: number }
export interface Box { left: number; top: number }
export interface PanelBox extends Box { width: number; height: number }

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));

/** Centro verticale della bolla dentro i margini. */
function clampCenterY(centerY: number, vp: Viewport): number {
  return clamp(centerY, EDGE + BUBBLE / 2, vp.height - EDGE - BUBBLE / 2);
}

/** Box della bolla agganciata al bordo, dalla posizione salvata. */
export function bubbleBox(pos: BubblePosition, vp: Viewport): Box {
  const left = pos.side === "left" ? EDGE : vp.width - EDGE - BUBBLE;
  return { left, top: clampCenterY(pos.y * vp.height, vp) - BUBBLE / 2 };
}

/** Box della bolla DURANTE il trascinamento: segue il puntatore, ma resta a schermo. */
export function clampBox(box: Box, vp: Viewport): Box {
  return {
    left: clamp(box.left, 0, vp.width - BUBBLE),
    top: clamp(box.top, EDGE, vp.height - EDGE - BUBBLE),
  };
}

/** Posizione da salvare al rilascio: lato più vicino al centro, y come frazione. */
export function snapPosition(centerX: number, centerY: number, vp: Viewport): BubblePosition {
  return {
    side: centerX < vp.width / 2 ? "left" : "right",
    y: clampCenterY(centerY, vp) / vp.height,
  };
}

/**
 * Dove si apre il pannello rispetto alla bolla `b`. Stesso lato della bolla
 * (dedotto dal suo centro, così vale anche mentre la si trascina); sopra se la
 * bolla è nella metà bassa, sotto se in quella alta; di fianco, verso
 * l'interno, se in quella direzione non restano PANEL_MIN_HEIGHT px.
 */
export function placePanel(b: Box, vp: Viewport): PanelBox {
  const onLeft = b.left + BUBBLE / 2 < vp.width / 2;
  const centerY = b.top + BUBBLE / 2;
  const below = centerY < vp.height / 2;
  const space = below ? vp.height - (b.top + BUBBLE + GAP) - EDGE : b.top - GAP - EDGE;

  if (space >= PANEL_MIN_HEIGHT) {
    const width = Math.min(PANEL_WIDTH, vp.width - 2 * EDGE);
    const height = Math.min(PANEL_MAX_HEIGHT, space);
    return {
      left: onLeft ? EDGE : vp.width - EDGE - width,
      top: below ? b.top + BUBBLE + GAP : b.top - GAP - height,
      width,
      height,
    };
  }

  // Di fianco: il pannello parte oltre la bolla, verso l'interno della pagina.
  const inset = EDGE + BUBBLE + GAP;
  const width = Math.min(PANEL_WIDTH, vp.width - inset - EDGE);
  const height = Math.min(PANEL_MAX_HEIGHT, vp.height - 2 * EDGE);
  return {
    left: onLeft ? inset : vp.width - inset - width,
    top: clamp(centerY - height / 2, EDGE, vp.height - EDGE - height),
    width,
    height,
  };
}
```

**Step 4:** `npx vitest run src/ui/placement.test.ts` → PASS. Se un'attesa
numerica non torna, ricontrollare prima il conto nel test (commentato accanto)
e poi il codice.

**Step 5:** commit `feat(widget): geometria di bolla e pannello`.

---

### Task 3: hook `useDraggableBubble`

**Files:**
- Create: `packages/widget/src/ui/use-draggable-bubble.ts`

Coperto dai test di integrazione del Task 4 (l'hook vive solo dentro
`WidgetRoot`; testarlo a parte richiederebbe un harness di hook che il package
non ha).

```ts
/**
 * Trascinamento della bolla. Pointer Events (mouse, touch e penna, un solo
 * codice): sotto DRAG_THRESHOLD px è un click normale; oltre è un trascinamento,
 * la bolla segue il puntatore e al rilascio si aggancia al bordo più vicino e
 * la posizione si salva per slug. Il click che il browser emette a fine
 * trascinamento va soppresso: `consumeClick()` lo dice a chi gestisce il click.
 *
 * I listener di move/up stanno su `window` e non sulla bolla: non servono
 * `setPointerCapture` (assente in alcuni ambienti) e il puntatore può uscire
 * dalla bolla durante un movimento veloce senza perdere il trascinamento.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { getPosition, setPosition, type BubblePosition } from "../core/storage.js";
import {
  BUBBLE,
  bubbleBox,
  clampBox,
  DEFAULT_POSITION,
  DRAG_THRESHOLD,
  snapPosition,
  type Box,
  type Viewport,
} from "./placement.js";

/** Viewport di layout (senza scrollbar); fallback su window per ambienti che danno 0. */
function readViewport(): Viewport {
  const el = document.documentElement;
  return {
    width: el.clientWidth || window.innerWidth,
    height: el.clientHeight || window.innerHeight,
  };
}

export function useDraggableBubble(slug: string) {
  const [position, setPos] = useState<BubblePosition>(() => getPosition(slug) ?? DEFAULT_POSITION);
  const [viewport, setViewport] = useState<Viewport>(readViewport);
  const [dragBox, setDragBox] = useState<Box | null>(null);
  const suppressClick = useRef(false);
  const detach = useRef<(() => void) | null>(null);

  useEffect(() => {
    const onResize = () => setViewport(readViewport());
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      detach.current?.();
    };
  }, []);

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    // Un click soppresso che il browser non ha poi emesso (succede col touch)
    // non deve mangiarsi il prossimo click vero.
    suppressClick.current = false;
    detach.current?.();
    const vp = readViewport();
    const origin = bubbleBox(position, vp);
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;

    const boxAt = (ev: PointerEvent) =>
      clampBox({ left: origin.left + ev.clientX - startX, top: origin.top + ev.clientY - startY }, readViewport());

    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
      moved = true;
      setDragBox(boxAt(ev));
    };
    const onUp = (ev: PointerEvent) => {
      remove();
      if (!moved) return;
      const now = readViewport();
      const box = boxAt(ev);
      const next = snapPosition(box.left + BUBBLE / 2, box.top + BUBBLE / 2, now);
      suppressClick.current = true;
      setDragBox(null);
      setViewport(now);
      setPos(next);
      setPosition(slug, next);
    };
    const remove = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      detach.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    detach.current = remove;
  }

  /** True (una volta sola) se il click appena arrivato chiude un trascinamento. */
  function consumeClick(): boolean {
    const s = suppressClick.current;
    suppressClick.current = false;
    return s;
  }

  return {
    viewport,
    bubble: dragBox ?? bubbleBox(position, viewport),
    dragging: dragBox !== null,
    onPointerDown,
    consumeClick,
  };
}
```

Verifica: `npx tsc --noEmit` → nessun errore. Nessun commit a sé (va col Task 4).

---

### Task 4: cablaggio in `WidgetRoot` + CSS

**Files:**
- Modify: `packages/widget/src/ui/widget.tsx`
- Modify: `packages/widget/src/ui/styles.ts`
- Test: `packages/widget/src/ui/widget.test.tsx`
- Test: `packages/widget/src/ui/styles.test.ts` (se asserisce `bottom`/`right`)

**Step 1: test che falliscono** — nuovo `describe("drag")` in `widget.test.tsx`.
Helper:

```ts
function pointer(target: EventTarget, type: string, x: number, y: number) {
  target.dispatchEvent(
    new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, composed: true }),
  );
}
/** Il root porta la geometria come variabili CSS. */
function cssVar(name: string): string {
  return shadow().querySelector<HTMLElement>(".sw-root")!.style.getPropertyValue(name);
}
```

Viewport dei test: in `beforeEach` del describe fissare
`window.innerWidth = 1280; window.innerHeight = 800` (via `vi.stubGlobal` o
`Object.defineProperty`, e verificare prima con un test sonda che cosa
restituisce `document.documentElement.clientWidth` in happy-dom: se ≠ 0, va
stubbato quello).

Casi:

1. **Movimento sotto soglia = click**: `pointerdown` a (1224, 752), `pointerup`
   a (1226, 753) su `window`, poi `bubble.click()` → il pannello si apre, e
   `localStorage.getItem("stubwise-widget:acme:position")` è `null`.
2. **Trascinamento non apre e salva**: `pointerdown` sulla bolla a (1224,752),
   `pointermove` su window a (200, 300), `pointerup` a (200, 300), poi
   `bubble.click()` (il click che il browser emetterebbe) → nessun pannello;
   storage = `{ side: "left", y: 0.375 }`; `--sw-bubble-left` = `20px`.
   Un secondo `bubble.click()` → il pannello si apre (la soppressione vale una
   volta sola).
3. **Posizione ripresa al rimontaggio**: storage pre-popolato con
   `{ side: "left", y: 0 }` prima di `initWidget` → `--sw-bubble-left` =
   `20px`, `--sw-bubble-top` = `20px`; aperto il pannello,
   `--sw-panel-top` = `88px` (si apre sotto).
4. **Default invariato**: senza storage, `--sw-bubble-left` = `1204px`,
   `--sw-bubble-top` = `724px`.
5. **Resize**: con `{ side: "right", y: 1 }`, cambiare `innerHeight` a 600 e
   lanciare `window.dispatchEvent(new Event("resize"))` → `--sw-bubble-top` =
   `524px`.

**Step 2:** `npx vitest run src/ui/widget.test.tsx` → i nuovi FAIL, i vecchi PASS.

**Step 3: `widget.tsx`**:
- `const drag = useDraggableBubble(base.slug);` e
  `const panel = placePanel(drag.bubble, drag.viewport);`
- root:
  ```tsx
  <div
    class={drag.dragging ? "sw-root sw-root--dragging" : "sw-root"}
    style={{
      "--sw-bubble-left": `${drag.bubble.left}px`,
      "--sw-bubble-top": `${drag.bubble.top}px`,
      "--sw-panel-left": `${panel.left}px`,
      "--sw-panel-top": `${panel.top}px`,
      "--sw-panel-width": `${panel.width}px`,
      "--sw-panel-height": `${panel.height}px`,
    }}
  >
  ```
- bolla: `onPointerDown={(e) => drag.onPointerDown(e)}` e
  `onClick={() => { if (drag.consumeClick()) return; setOpen((v) => !v); }}`.
- Aggiornare il docblock in testa al file (la bolla non è più "sempre in basso
  a destra": si trascina, vedi `use-draggable-bubble.ts`).

**Step 4: `styles.ts`**:
- `.sw-bubble`: togliere `bottom: 20px; right: 20px;`, aggiungere
  `left: var(--sw-bubble-left); top: var(--sw-bubble-top); touch-action: none;
  user-select: none; -webkit-user-select: none; transition: left 0.18s ease-out,
  top 0.18s ease-out;`. Commento: "posizione dal JS come variabili, vedi
  placement.ts".
- `.sw-root--dragging .sw-bubble { transition: none; cursor: grabbing; }`
- `.sw-panel`: togliere `bottom: 88px; right: 20px; width: 380px; height:
  600px; max-height: calc(100vh - 108px);`, aggiungere `left:
  var(--sw-panel-left); top: var(--sw-panel-top); width:
  var(--sw-panel-width); height: var(--sw-panel-height);`.
- La media query `max-width: 480px` NON cambia: `inset: 0; width: 100%;
  height: 100%;` stanno dopo con la stessa specificità e vincono sulle
  variabili. Aggiungere una riga di commento che lo dica.
- Se `styles.test.ts` asserisce le vecchie regole, aggiornarlo; aggiungere
  un'asserzione che il CSS contenga `var(--sw-panel-top)` e che la media query
  contenga ancora `inset: 0`.

**Step 5:** `npx vitest run` (tutto il package) → PASS. `npx tsc --noEmit` →
pulito. Se TS rifiuta le chiavi `--sw-*` nell'oggetto `style`, tipizzarlo come
`Record<string, string>` con un cast esplicito commentato.

**Step 6:** commit `feat(widget): bolla trascinabile e pannello che si apre dove c'è spazio`.

---

### Task 5: guida utente

**Files:**
- Modify: `apps/docs/src/content/docs/integrations/widget.md`

Aggiungere una breve sezione "Posizione" (nella lingua della pagina): la bolla
parte in basso a destra; ogni visitatore può trascinarla, si aggancia al bordo
sinistro o destro e la posizione resta salvata nel suo browser; la chat si apre
dove c'è spazio. Commit `docs(widget): la bolla si trascina`.

---

### Task 6: verifica finale

1. Dalla radice del worktree: `pnpm --filter @stubwise/widget... build`,
   `pnpm --filter @stubwise/widget test`, `pnpm --filter @stubwise/widget
   typecheck`, `pnpm lint`. Esiti catturati prima di qualunque `| tail`.
2. Test manuale su una pagina HTML locale che carica
   `packages/widget/dist/stubwise-widget.js` (sonda con `fetch` della config
   verso l'istanza di prod o mock): trascinare a sinistra a metà, ricaricare,
   aprire → pannello di fianco o sopra/sotto e sempre intero; finestra bassa;
   DevTools in modalità telefono (fullscreen invariato, trascinamento col
   touch). Un test alla volta con l'utente, desktop poi telefono.
3. PR verso main; deploy = rebuild di `caddy`.
