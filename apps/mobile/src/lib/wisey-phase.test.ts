import { WISEY_CYCLE_MS, WISEY_STAGE_MS, WISEY_WORD_MS, wiseyPhase, type WiseyStage } from "./wisey-phase";

/**
 * La fase del gufo NON si sceglie a mano: è una funzione dello stato
 * («Wisey, anteprima nell'app» §5). Oggi lo stato è quello delle risposte
 * finte; quando arriverà il job vero cambierà l'input, non questa tabella.
 */
describe("wiseyPhase", () => {
  test("niente in corso, campo non a fuoco: riposo", () => {
    expect(wiseyPhase({ stage: "idle", inputFocused: false, hasText: false, doneUnseen: false })).toBe("rest");
  });

  test("campo a fuoco, o testo già scritto: ti ascolta", () => {
    expect(wiseyPhase({ stage: "idle", inputFocused: true, hasText: false, doneUnseen: false })).toBe("listen");
    expect(wiseyPhase({ stage: "idle", inputFocused: false, hasText: true, doneUnseen: false })).toBe("listen");
  });

  test.each<[WiseyStage, string]>([
    ["thinking", "think"],
    ["working", "work"],
    ["answering", "speak"],
    ["done", "done"],
  ])("durante il lavoro il campo non conta: %s → %s", (stage, phase) => {
    // Anche col campo a fuoco: mentre Wisey lavora, il gufo dice cosa fa LUI.
    expect(wiseyPhase({ stage, inputFocused: true, hasText: true, doneUnseen: false })).toBe(phase);
    expect(wiseyPhase({ stage, inputFocused: false, hasText: false, doneUnseen: false })).toBe(phase);
  });

  /**
   * «Done» resta finché non l'hai visto (design §10): una risposta finita
   * mentre la tab Wisey non era a fuoco tiene il gufo su «fatto», nella
   * barra e nella pagina, qualunque cosa dica il resto dello stato.
   */
  test("una risposta non ancora vista: «fatto», sopra ogni altra regola", () => {
    expect(wiseyPhase({ stage: "idle", inputFocused: false, hasText: false, doneUnseen: true })).toBe("done");
    expect(wiseyPhase({ stage: "idle", inputFocused: true, hasText: true, doneUnseen: true })).toBe("done");
  });
});

describe("le durate, dal design", () => {
  test("i cicli dello sprite", () => {
    expect(WISEY_CYCLE_MS).toEqual({ rest: 3200, listen: 600, think: 1400, work: 1000, speak: 480, done: 1400 });
  });

  test("quanto dura ogni passo della risposta finta", () => {
    expect(WISEY_STAGE_MS).toEqual({ thinking: 1500, working: 2500, done: 1400 });
  });

  test("una parola per fotogramma del becco: il ciclo di «ti risponde» diviso i suoi quattro passi", () => {
    expect(WISEY_WORD_MS).toBe(WISEY_CYCLE_MS.speak / 4);
  });
});
