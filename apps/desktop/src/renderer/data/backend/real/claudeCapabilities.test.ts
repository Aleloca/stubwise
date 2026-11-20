import { describe, expect, it } from "vitest";
import { capabilitiesEventsOf } from "./claudeCapabilities";

// S0 nella build app (area 10, F7 di 72): il ponte scrive l'evento
// `capabilities` con gli id del prototipo che chi chiede può davvero usare
// (F7-1 = a: niente `product*` finché l'area 11 non c'è). Le frasi restano del
// renderer (`CapabilitiesList`). Un id che questo renderer non conosce, o che
// il lettore ha letto `UNKNOWN`, si salta.

const raw = (id: string, data: unknown) =>
  ({ id, at: "2026-11-20T10:00:00.000Z", type: "capabilities", segmentId: "s1", data }) as never;

describe("l'evento `capabilities` nella build app", () => {
  it("l'elenco del server diventa quello del prototipo, nel suo ordine", () => {
    expect(
      capabilitiesEventsOf([raw("7", { items: ["automation", "stalled", "taskDescription"] })]),
    ).toEqual([
      {
        id: "capabilities:7",
        at: "2026-11-20T10:00:00.000Z",
        type: "capabilities",
        items: ["automation", "stalled", "taskDescription"],
      },
    ]);
  });

  it("un id ignoto (UNKNOWN, o di un server più nuovo) si salta; un elenco vuoto o malformato non dà niente", () => {
    expect(
      capabilitiesEventsOf([raw("7", { items: ["__unknown__", "spend", "teleport"] })]),
    ).toMatchObject([{ items: ["spend"] }]);
    expect(
      capabilitiesEventsOf([raw("8", { items: ["__unknown__"] }), raw("9", { nope: true })]),
    ).toEqual([]);
    expect(
      capabilitiesEventsOf([
        {
          id: "1",
          at: "x",
          type: "assistant_text",
          segmentId: "s1",
          data: { text: "hi" },
        } as never,
      ]),
    ).toEqual([]);
  });
});
