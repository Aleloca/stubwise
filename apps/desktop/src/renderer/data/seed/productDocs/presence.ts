import type { ProductScriptStep } from "../../types";
import { METER_IDS } from "./acq";

// I copioni del seme (area 11a, Task 3), eseguiti dal Task 5: una persona
// entra in una pagina, scrive, se ne va. Sono dati, nessun timer. L'id del
// blocco che un `insert` scrive sta FUORI da `productBlockIds` (ruling P11):
// se ci fosse, la scrittura darebbe `block_id_taken`.

const MARCO = "p-marco";
const MATTEO = "p-matteo";

/** Marco, in 8 pezzi: «Readings sent after the 25th count for the next bill.» */
const PIECES = [
  "Readings ",
  "sent ",
  "after ",
  "the ",
  "25th ",
  "count ",
  "for the ",
  "next bill.",
];

/** Per id di pagina: la pagina Meter reading. */
export const PRODUCT_SCRIPTS: Record<string, ProductScriptStep[]> = {
  [METER_IDS.pageId]: [
    // Matteo c'è e non scrive.
    { step: "enter", personId: MATTEO, anchorId: null },
    { step: "enter", personId: MARCO, anchorId: METER_IDS.rules },
    {
      step: "insert",
      personId: MARCO,
      afterId: METER_IDS.afterRules,
      blockId: METER_IDS.scripted,
    },
    ...PIECES.map(
      (text): ProductScriptStep => ({
        step: "type",
        personId: MARCO,
        anchorId: METER_IDS.scripted,
        text,
      }),
    ),
    { step: "leave", personId: MARCO },
  ],
};
