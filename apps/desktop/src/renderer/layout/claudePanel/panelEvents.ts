import { useSyncExternalStore } from "react";

// Il riquadro di Claude (area 10a, Task 8) si apre da più porte — ⌘J, la
// voce di menu «Ask Claude…», il bottone del binario, «Ask Claude…» di ⌘K —
// con un solo evento, come la palette e le notifiche. Il riquadro dice al
// binario se è aperto e se Claude sta rispondendo (o ha risposto) mentre è
// chiuso, con un piccolo archivio di modulo.

/** Evento che apre (o alterna) il riquadro di Claude. */
export const CLAUDE_PANEL_EVENT = "stubwise:claude-panel";
/** L'id del riquadro, per l'`aria-controls` del bottone del binario. */
export const CLAUDE_PANEL_ID = "claude-panel";

export interface ClaudePanelEventDetail {
  /** Il testo da mettere nella casella, NON inviato (⌘K «Ask Claude: …»). */
  draft?: string;
  /** `toggle` alterna (⌘J, menu, binario); `open` (default) apre e basta. */
  mode?: "open" | "toggle";
  /**
   * Area 10b (Task 12, la riga «Claude can help you…»): apre una
   * conversazione NUOVA con `draft` nella casella, sempre non inviato. Quella
   * di prima resta in Claude → Mine, col suo testo non inviato ([SG 6]).
   */
  fresh?: boolean;
}

export function openClaudePanel(detail: ClaudePanelEventDetail = {}): void {
  window.dispatchEvent(new CustomEvent<ClaudePanelEventDetail>(CLAUDE_PANEL_EVENT, { detail }));
}

// --- ⌘J una volta sola --------------------------------------------------------
//
// L'acceleratore del menu (CmdOrCtrl+J) e il keydown del renderer possono
// arrivare entrambi per la stessa pressione, in un ordine qualunque: la
// seconda porta che arriva entro poco dalla prima, se è l'altra, non alterna.

const SAME_PRESS_MS = 400;
let lastPress: { source: "key" | "menu"; at: number } | null = null;

/** Vero se questa porta deve alternare il riquadro (non è l'eco dell'altra). */
export function claimPanelToggle(source: "key" | "menu"): boolean {
  const at = performance.now();
  const echo =
    lastPress !== null && lastPress.source !== source && at - lastPress.at < SAME_PRESS_MS;
  lastPress = echo ? null : { source, at };
  return !echo;
}

/** Dimentica l'ultima pressione (i test). */
export function resetPanelToggle(): void {
  lastPress = null;
}

// --- lo stato che legge il binario ---------------------------------------------

export interface ClaudePanelStatus {
  open: boolean;
  /**
   * Solo a riquadro chiuso: `answering` mentre Claude risponde, `answered`
   * a risposta finita, finché non si riapre ([CP 6]).
   */
  signal: "answering" | "answered" | null;
}

const CLOSED: ClaudePanelStatus = { open: false, signal: null };
let status: ClaudePanelStatus = CLOSED;
const listeners = new Set<() => void>();

export function setClaudePanelStatus(next: ClaudePanelStatus): void {
  if (next.open === status.open && next.signal === status.signal) return;
  status = next;
  for (const l of listeners) l();
}

// --- D2: la pagina aperta dal riquadro gli sta accanto --------------------------
//
// Finita la prova, il riquadro apre il costruttore e resta aperto (area 10b,
// D2). Su quella pagina — e solo finché c'è «Back to …» col riquadro aperto —
// il flusso sta ACCANTO al riquadro, non sotto (shape claude-automations
// §3.5/§6): la pagina della prova lascia al riquadro la sua larghezza e il layout
// chiude la colonna ([AU 12]). Fuori da quella scena vale [CP 1]: il riquadro copre.

let beside = 0;
const besideListeners = new Set<() => void>();

/** La larghezza del riquadro da lasciare accanto alla pagina aperta da D2; `0` = nessuna. */
export function setClaudeBeside(width: number): void {
  if (width === beside) return;
  beside = width;
  for (const l of besideListeners) l();
}

export function useClaudeBeside(): number {
  return useSyncExternalStore(
    (l) => {
      besideListeners.add(l);
      return () => besideListeners.delete(l);
    },
    () => beside,
    () => 0,
  );
}

export function useClaudePanelStatus(): ClaudePanelStatus {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
    () => CLOSED,
  );
}
