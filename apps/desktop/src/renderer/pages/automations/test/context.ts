import { createContext, useContext } from "react";
import type { AutomationFlow, AutomationRow, DataField, SimulationView } from "../../../data/types";
import type { SimulationInput } from "../../../data/queries";
import type { Names } from "../format";
import type { SimIndex } from "./marks";

// Lo stato della prova che righe, pannello e riepilogo condividono: il
// flusso provato (la versione della prova, non quello a schermo nel
// costruttore), la prova di adesso e le scelte della vista (passo
// selezionato, giro scelto per ogni ciclo).

export interface TestState {
  automation: AutomationRow;
  flow: AutomationFlow;
  names: Names;
  labels: Map<string, DataField>;
  /** Percorso del flusso (giri a 0) → numero 1…N (R-J17). */
  numbers: Map<string, number>;
  /** Id del passo → numero 1…N. */
  numberOf: (stepId: string) => number | undefined;
  me: string;
  sim: SimulationView | null;
  ix: SimIndex | null;
  /** Il percorso concreto selezionato (`trigger` per l'inizio); null = segue il passo corrente. */
  selected: string | null;
  select(path: string | null): void;
  /** Il giro scelto di un ciclo (percorso concreto del blocco → giro). */
  roundOf(blockPath: string): number;
  setRound(blockPath: string, round: number): void;
  /** Un input della prova (un passo, uno sblocco); gli errori li dice la pagina. */
  /** Lo stato della prova dopo l'input, o `null` se non è passato. */
  send(input: SimulationInput): Promise<SimulationView | null>;
  /** Un input in volo (o «Run to next stop» che avanza): i comandi aspettano. */
  busy: boolean;
  /** La motivazione di Claude che arriva in streaming: il passo e il testo finora. */
  stream: { path: string; text: string } | null;
}

export const TestContext = createContext<TestState | null>(null);

export function useTest(): TestState {
  const ctx = useContext(TestContext);
  if (!ctx) throw new Error("useTest outside the test");
  return ctx;
}

/** Il percorso del flusso di un percorso concreto (`forEach[3]` → `forEach[0]`). */
export const flowPathOf = (path: string) => path.replace(/\[\d+\]/g, "[0]");

/** Le props delle anteprime condivise, dal contesto della prova. */
export function usePreviewProps() {
  const ctx = useTest();
  return {
    words: { names: ctx.names, numberOf: ctx.numberOf, labels: ctx.labels },
    // Una bozza mai accesa partirebbe dalla casella di chi prova: «because you'd be the owner».
    fromYours: !!ctx.sim?.draft && ctx.sim.ownerId === ctx.me,
  };
}
