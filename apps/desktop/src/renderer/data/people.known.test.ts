import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accessState, isFullAdmin, writeAccess } from "./access/index";
import { knownPeopleFor } from "./access/whoCan";
import { listPeople, resetApi, setLatency } from "./api";
import { PEOPLE } from "./seed/people";
import { setSessionPersonId } from "./session";

// Registro, A11 r.1414 (decisione del maintainer, 23 nov 2026), passo 2:
// l'elenco delle persone del prototipo dà solo chi guarda conosce, come quello
// del server. Prima dava TUTTE le persone a chiunque, e la pagina risolveva
// il nome di chiunque da un id. Restano chi guarda, i disattivati e gli ex
// membri dei progetti visibili (con `deactivated`).

const LAURA = "p-laura";

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("listPeople solo coi conosciuti (r.1414)", () => {
  it("chi non si conosce non c'è; chi guarda sì", async () => {
    setSessionPersonId(LAURA);
    const outsider = PEOPLE.find(
      (p) => p.id !== "p-claude" && !isFullAdmin(p.id) && !knownPeopleFor(LAURA).has(p.id),
    );
    expect(outsider).toBeDefined();
    const ids = (await listPeople()).map((p) => p.id);
    expect(ids).toContain(LAURA);
    expect(ids).not.toContain(outsider!.id);
  });

  it("un membro disattivato di un progetto visibile resta, col segno `deactivated`", async () => {
    const marco = "p-marco";
    expect(accessState().memberships.some((m) => m.personId === marco)).toBe(true);
    writeAccess((s) => {
      const row = s.people.find((p) => p.personId === marco)!;
      row.status = "deactivated";
      row.deactivatedAt = "2026-11-20T10:00:00Z";
    });
    setSessionPersonId(LAURA);
    expect((await listPeople()).find((p) => p.id === marco)?.deactivated).toBe(true);
  });

  it("Claude resta nell'elenco (non è una persona da nascondere)", async () => {
    setSessionPersonId(LAURA);
    expect((await listPeople()).some((p) => p.id === "p-claude")).toBe(
      PEOPLE.some((p) => p.id === "p-claude"),
    );
  });
});
