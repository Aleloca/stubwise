import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accessState, isFullAdmin, writeAccess } from "./access/index";
import { listPeople, resetApi, setLatency } from "./api";
import { PEOPLE } from "./seed/people";
import { setSessionPersonId } from "./session";
import { state, visibleProjectIds } from "./store";
import { strangersTo } from "../test/strangers";

/** Chi non condivide progetti visibili con `viewer` (senza toccare lo stato). */
const strangersCandidates = (viewer: string) =>
  PEOPLE.filter(
    (p) =>
      p.id !== viewer &&
      !isFullAdmin(p.id) &&
      !state.projects.some((x) => visibleProjectIds(viewer).has(x.id) && x.memberIds.includes(p.id)),
  ).map((p) => p.id);

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
    const [outsider] = strangersTo(LAURA);
    setSessionPersonId(LAURA);
    const ids = (await listPeople()).map((p) => p.id);
    expect(ids).toContain(LAURA);
    expect(ids).not.toContain(outsider);
  });

  // Decisione del maintainer (23 nov 2026): «chi scrive in un canale che vedo
  // è conosciuto». Enrico non ha progetti in comune con Laura, ma sono tutti e
  // due in ch-announcements.
  it("un canale di tutta l'azienda fa conoscere chi ne è membro, anche senza progetti in comune", async () => {
    const enrico = "p-enrico";
    expect(strangersCandidates(LAURA)).toContain(enrico);
    setSessionPersonId(LAURA);
    expect((await listPeople()).map((p) => p.id)).toContain(enrico);
  });

  it("chi ha scritto in un canale leggibile è conosciuto anche se non ne è più membro", async () => {
    const [who] = strangersTo(LAURA);
    const seed = state.chatMessages.find((m) => m.channelId === "ch-announcements" && m.kind === "person")!;
    state.chatMessages.push({ ...structuredClone(seed), id: "m-left-author", authorId: who! });
    setSessionPersonId(LAURA);
    expect((await listPeople()).map((p) => p.id)).toContain(who);
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
