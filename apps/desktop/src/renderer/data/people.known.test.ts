import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accessState, isFullAdmin, writeAccess } from "./access/index";
import { peopleKnownTo } from "../domain/access/whoCan";
import { listPeople, resetApi, setLatency } from "./api";
import { PEOPLE } from "./seed/people";
import { setSessionPersonId } from "./session";
import { archivedProjectIdsFor, state, visibleProjectIds } from "./store";
import { knownPeopleFor } from "./access/whoCan";
import { strangersTo, withoutChannels } from "../test/strangers";

/** Chi non condivide progetti visibili con `viewer` (senza toccare lo stato). */
const strangersCandidates = (viewer: string) =>
  PEOPLE.filter(
    (p) =>
      p.id !== viewer &&
      !isFullAdmin(p.id) &&
      !state.projects.some(
        (x) => visibleProjectIds(viewer).has(x.id) && x.memberIds.includes(p.id),
      ),
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

// Revisione del lotto 2 (I3): il predicato dei PROGETTI da solo (senza i
// canali, che col canale generale del progetto fanno conoscere i suoi membri
// comunque): un disattivato e un ex membro di un progetto visibile ci sono.
describe("peopleKnownTo, i progetti (r.1414)", () => {
  const known = () =>
    peopleKnownTo({
      state: accessState(),
      viewerId: LAURA,
      visibleProjectIds: visibleProjectIds(LAURA),
    });

  it("un membro disattivato di un progetto visibile è conosciuto", () => {
    writeAccess((s) => {
      const row = s.people.find((p) => p.personId === "p-marco")!;
      row.status = "deactivated";
      row.deactivatedAt = "2026-11-20T10:00:00Z";
    });
    expect(known().has("p-marco")).toBe(true);
  });

  it("un ex membro (uscito da ogni progetto) è conosciuto per `formerMemberships`", () => {
    writeAccess((s) => {
      s.memberships = s.memberships.filter((m) => m.personId !== "p-marco");
    });
    expect(accessState().formerMemberships.some((m) => m.personId === "p-marco")).toBe(true);
    expect(known().has("p-marco")).toBe(true);
  });

  // Revisione del lotto 2 (I2, decisione di 46): un archiviato che chi guarda
  // può leggere conta come visibile per «chi si conosce».
  it("un membro di un progetto archiviato che chi guarda legge è conosciuto", () => {
    const MARCO = "p-marco";
    expect(archivedProjectIdsFor(MARCO).has("prj-rnc")).toBe(true);
    const [who] = strangersTo(MARCO);
    writeAccess((s) => {
      const like = s.memberships.find((m) => m.projectId === "prj-rnc")!;
      s.memberships.push({ ...like, personId: who! });
    });
    withoutChannels(MARCO, [who!]);
    expect(knownPeopleFor(MARCO).has(who!)).toBe(true);
  });

  it("il seme: ogni `member.removed` del registro ha la sua riga di ex membro", () => {
    const removed = state.changelog.filter((e) => e.kind === "member.removed" && e.projectId);
    expect(removed.length).toBeGreaterThan(0);
    for (const e of removed) {
      expect(
        accessState().formerMemberships.some(
          (m) => m.projectId === e.projectId && m.personId === e.object.id,
        ),
        `${e.object.id} da ${e.projectId}`,
      ).toBe(true);
    }
  });

  it("il ripristino del seme non è un'uscita: nessun ex membro in più", () => {
    const before = accessState().formerMemberships.length;
    resetApi();
    expect(accessState().formerMemberships.length).toBe(before);
  });
});

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
    const seed = state.chatMessages.find(
      (m) => m.channelId === "ch-announcements" && m.kind === "person",
    )!;
    state.chatMessages.push({ ...structuredClone(seed), id: "m-left-author", authorId: who! });
    setSessionPersonId(LAURA);
    expect((await listPeople()).map((p) => p.id)).toContain(who);
  });

  it("un membro disattivato di un progetto visibile resta, col segno `deactivated`", async () => {
    // Revisione del lotto 2 (I3): fuori dai canali leggibili, lo fa conoscere solo il progetto.
    withoutChannels(LAURA, ["p-marco"]);
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
