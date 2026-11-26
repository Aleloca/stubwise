import { afterEach, describe, expect, it, vi } from "vitest";
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

// Area 11, F6 (R11-6): le capacità `product*` (prima versione, aggiornamento,
// backlog, wireframe, cambi della settimana) si mostrano solo con i gesti di
// Claude sulla doc accesi (`product-claude-actions`): un server che le manda
// a un renderer che non li ha prometterebbe gesti che qui non ci sono.
describe("le capacità `product*` (F6)", () => {
  const PRODUCT = [
    "productFirstVersion",
    "productUpdate",
    "productBacklog",
    "productWireframe",
    "productChanges",
  ];

  afterEach(() => vi.unstubAllEnvs());

  it("nella build app, col cancello acceso (22 nov 2026), passano insieme alle altre", async () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    const { featureIntegrated } = await import("../../integration");
    expect(featureIntegrated("product-claude-actions")).toBe(true);
    expect(capabilitiesEventsOf([raw("7", { items: ["spend", ...PRODUCT] })])).toMatchObject([
      { items: ["spend", ...PRODUCT] },
    ]);
  });

  it("nel prototipo (tutto acceso) passano", () => {
    expect(capabilitiesEventsOf([raw("9", { items: PRODUCT })])).toMatchObject([
      { items: PRODUCT },
    ]);
  });
});
