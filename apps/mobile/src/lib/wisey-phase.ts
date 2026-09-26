/**
 * LE FASI DI WISEY («Wisey, anteprima nell'app», 25 set 2026, design §5).
 *
 * Il gufo non sceglie a mano come muoversi: la fase è una FUNZIONE dello
 * stato, e sta tutta in {@link wiseyPhase}. Oggi lo stato è quello delle
 * risposte finte della schermata; quando Wisey parlerà con un job vero
 * cambierà chi produce lo `stage`, non questa tabella.
 *
 * Le fasi hanno nomi inglesi nel codice; gli sprite dell'export di design
 * hanno nomi italiani (`gufo-riposo.png`…) e la corrispondenza sta nello
 * sprite, in un posto solo.
 */

/** Il punto della conversazione in cui si trova Wisey. */
export type WiseyStage = "idle" | "thinking" | "working" | "answering" | "done";

/** Le sei fasi del gufo, una per sprite. */
export type WiseyPhase = "rest" | "listen" | "think" | "work" | "speak" | "done";

export interface WiseyState {
  stage: WiseyStage;
  /** Il campo di testo ha il fuoco. */
  inputFocused: boolean;
  /** Nel campo c'è già qualcosa di scritto. */
  hasText: boolean;
  /**
   * Una risposta è finita mentre la tab Wisey NON era a fuoco, e nessuno
   * l'ha ancora vista (design §10): il gufo resta su «fatto», nella barra e
   * nella pagina, finché la tab non va a fuoco.
   */
  doneUnseen: boolean;
}

/**
 * La tabella del design §5, più il §10: una risposta non ancora vista vince
 * su tutto. Fuori dal riposo il campo non conta: mentre Wisey lavora il gufo
 * dice cosa fa LUI, non cosa fa chi scrive.
 */
export function wiseyPhase(state: WiseyState): WiseyPhase {
  if (state.doneUnseen) return "done";
  switch (state.stage) {
    case "thinking":
      return "think";
    case "working":
      return "work";
    case "answering":
      return "speak";
    case "done":
      return "done";
    case "idle":
      return state.inputFocused || state.hasText ? "listen" : "rest";
  }
}

/** La durata di UN ciclo di quattro fotogrammi, per fase (dal design). */
export const WISEY_CYCLE_MS: Record<WiseyPhase, number> = {
  rest: 3200,
  listen: 600,
  think: 1400,
  work: 1000,
  speak: 480,
  done: 1400,
};

/**
 * Quanto restano le fasi a tempo della risposta finta: «sta pensando» circa
 * 1,5 s, «sta lavorando» circa 2,5 s (solo per le domande che chiedono di
 * FARE qualcosa), «fatto» un giro solo del suo ciclo, poi riposo.
 */
export const WISEY_STAGE_MS = {
  thinking: 1500,
  working: 2500,
  done: WISEY_CYCLE_MS.done,
} as const;

/**
 * Il testo della risposta compare parola per parola, a tempo col becco: una
 * parola per fotogramma di «ti risponde».
 */
export const WISEY_WORD_MS = WISEY_CYCLE_MS.speak / 4;
