import { describe, expect, it } from "vitest";

import { applyEdits, EditFailed } from "./applyEdits";

const event = {
  id: "ev-1",
  // Come lo scrive il server: senza millisecondi.
  startsAt: "2026-11-13T09:00:00Z",
  endsAt: "2026-11-13T10:00:00Z",
  allDay: false,
  projectId: "prj-a" as string | null,
};
const patch = { title: "Kick-off v2" };

function ops(movedId = "ev-1") {
  const calls: string[] = [];
  return {
    calls,
    move: async (v: { id: string }) => {
      calls.push(`move ${v.id}`);
      return { id: movedId };
    },
    update: async (v: { id: string }) => {
      calls.push(`update ${v.id}`);
      return { id: v.id };
    },
    setProject: async (v: { id: string }) => {
      calls.push(`project ${v.id}`);
      return { id: v.id };
    },
  };
}

describe("applyEdits: orari, poi dettagli, poi progetto", () => {
  it("«tutta la serie»: i passi dopo lo spostamento usano l'id che la move ha restituito (review F4, 3)", async () => {
    const o = ops("ev-series-new");
    await applyEdits(
      o,
      event,
      {
        startsAt: "2026-11-13T11:00:00.000Z",
        endsAt: "2026-11-13T12:00:00.000Z",
        allDay: false,
        patch,
        projectId: null,
      },
      "series",
    );
    expect(o.calls).toEqual(["move ev-1", "update ev-series-new", "project ev-series-new"]);
  });

  it("lo stesso orario scritto diversamente non sposta (review F4, 2)", async () => {
    const o = ops();
    await applyEdits(
      o,
      event,
      {
        startsAt: "2026-11-13T09:00:00.000Z",
        endsAt: "2026-11-13T10:00:00.000Z",
        allDay: false,
        patch,
        projectId: "prj-a",
      },
      "one",
    );
    expect(o.calls).toEqual(["update ev-1"]);
  });

  it("un rifiuto dice fin dove è arrivato", async () => {
    const o = ops();
    o.update = async () => {
      throw new Error("invalid: title");
    };
    const err = await applyEdits(
      o,
      event,
      {
        startsAt: "2026-11-13T11:00:00.000Z",
        endsAt: "2026-11-13T12:00:00.000Z",
        allDay: false,
        patch,
        projectId: "prj-a",
      },
      "one",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EditFailed);
    expect((err as EditFailed).saved).toBe("time");
  });
});

describe("announcesSaved: «creata»/«aggiornata» solo se non è rimasta «non salvata» (review F4, 4)", () => {
  it("salvata o in salvataggio: sì; non salvata (502, «Retry» sul blocco): no", async () => {
    const { announcesSaved } = await import("./applyEdits");
    expect(announcesSaved({ save: { state: "saved" } })).toBe(true);
    expect(announcesSaved({})).toBe(true);
    expect(announcesSaved({ save: { state: "failed", error: "unreachable" } })).toBe(false);
  });
});
