import { WISEY_CYCLE_MS, WISEY_STAGE_MS, WISEY_WORD_MS, wiseyPhase, type WiseyStage } from "./wisey-phase";

/**
 * La fase del gufo NON si sceglie a mano: è una funzione dello stato
 * («Wisey, anteprima nell'app» §5). Oggi lo stato è quello delle risposte
 * finte; quando arriverà il job vero cambierà l'input, non questa tabella.
 */
describe("wiseyPhase", () => {
  test("niente in corso, campo non a fuoco: riposo", () => {
    expect(wiseyPhase({ stage: "idle", inputFocused: false, hasText: false })).toBe("rest");
  });

  test("campo a fuoco, o testo già scritto: ti ascolta", () => {
    expect(wiseyPhase({ stage: "idle", inputFocused: true, hasText: false })).toBe("listen");
    expect(wiseyPhase({ stage: "idle", inputFocused: false, hasText: true })).toBe("listen");
  });

  test.each<[WiseyStage, string]>([
    ["thinking", "think"],
    ["working", "work"],
    ["answering", "speak"],
    ["done", "done"],
  ])("durante il lavoro il campo non conta: %s → %s", (stage, phase) => {
    // Anche col campo a fuoco: mentre Wisey lavora, il gufo dice cosa fa LUI.
    expect(wiseyPhase({ stage, inputFocused: true, hasText: true })).toBe(phase);
    expect(wiseyPhase({ stage, inputFocused: false, hasText: false })).toBe(phase);
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
