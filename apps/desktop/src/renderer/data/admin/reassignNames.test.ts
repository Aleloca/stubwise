import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admin, resetApi, setLatency } from "../api";
import { PEOPLE } from "../seed/people";
import { setSessionPersonId } from "../session";

// Revisione del lotto 2, I8 (r.1414): l'elenco delle persone del prototipo è
// ristretto a chi guarda conosce, ma la directory di Amministrazione è fuori
// dalla regola. Il dialogo «Deactivate» non può cercare i nomi in quell'elenco:
// il livello dati li dà insieme a `reassignTo` (`reassignNames`).

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("i nomi di «Reassign to» (revisione del lotto 2, I8)", () => {
  it("per ogni persona offerta c'è il suo nome, dal livello dati", async () => {
    setSessionPersonId("p-roberta");
    const person = await admin.getPerson("p-marco");
    expect(person.openTasks.length).toBeGreaterThan(0);
    for (const task of person.openTasks) {
      expect(task.reassignTo.length).toBeGreaterThan(0);
      for (const id of task.reassignTo) {
        expect(task.reassignNames?.[id], `${task.code} → ${id}`).toBe(
          PEOPLE.find((p) => p.id === id)!.name,
        );
      }
    }
  });
});
