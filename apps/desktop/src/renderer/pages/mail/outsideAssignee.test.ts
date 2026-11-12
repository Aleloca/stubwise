import { describe, expect, it } from "vitest";
import { isOutsideAssignee } from "./proposalText";

// L'incaricato «fuori dal progetto» di una proposta della posta: per quello
// del modello lo dice il server (`outsiders`); per uno scelto nella modifica
// sul posto si guardano i membri del progetto, se si conoscono.

describe("isOutsideAssignee", () => {
  const outsiders = new Set(["p-out"]);
  it("l'incaricato del modello: lo dice il server", () => {
    expect(isOutsideAssignee("p-out", "p-out", outsiders, new Set(["p-a"]))).toBe(true);
    expect(isOutsideAssignee("p-a", "p-a", outsiders, new Set())).toBe(false);
  });
  it("uno scelto nella modifica: fuori se non è fra i membri", () => {
    expect(isOutsideAssignee("p-b", "p-a", outsiders, new Set(["p-a"]))).toBe(true);
    expect(isOutsideAssignee("p-a", "p-x", outsiders, new Set(["p-a"]))).toBe(false);
  });
  it("membri che non si conoscono (l'elenco non si è letto): non si deduce, decide il server", () => {
    expect(isOutsideAssignee("p-b", "p-a", outsiders, new Set())).toBe(false);
  });
});
