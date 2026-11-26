import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../../i18n";
import { asideEventsOf } from "./claudeAsides";

// «Hypothesis» e «Details» sotto la risposta di S2 nella build app (area 10,
// F3 di 72): l'evento `aside` della sessione arriva già arricchito per chi
// guarda (le sole righe dei progetti che vede, l'ipotesi null se la sua riga
// non c'è più). Il renderer compone le due righe del prototipo nella lingua
// di chi guarda. «Details» dice la soglia dei progetti mostrati
// (`thresholdDays`, la regola della lista delle task: decisione del
// maintainer), come il prototipo.

const at = "2026-11-19T10:41:00.000Z";
const row = (over: Record<string, unknown> = {}) => ({
  projectId: "p1",
  projectCode: "AUD",
  count: 3,
  ticketId: "t1",
  taskCode: "AUD-12",
  stalledSince: "2026-11-01",
  reason: "to_prepare",
  closed: false,
  thresholdDays: 10,
  ...over,
});
const IT_DETAILS =
  "Una task è ferma quando non cambia da più della soglia del suo progetto (AUD: 10 giorni). Solo progetti aperti. Letto alle 10:41.";
const aside = (data: unknown, id = "a1") => ({ id, at, type: "aside", data }) as never;

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("le righe sotto la risposta di S2 nella build app", () => {
  it("ipotesi e dettagli, nell'ordine, coi codici della task", () => {
    const events = asideEventsOf([
      aside({
        rows: [row()],
        hypothesis: { ticketId: "t1", taskCode: "AUD-12", key: "out_of_plan" },
      }),
    ]);
    expect(events).toEqual([
      {
        id: "aside:a1:hypothesis",
        at,
        type: "aside",
        kind: "hypothesis",
        text: "AUD-12 may have fallen out of planning: it has no week",
      },
      {
        id: "aside:a1:details",
        at,
        type: "aside",
        kind: "details",
        text: "A task counts as stalled when it hasn't changed for longer than its project's threshold (AUD: 10 days). Only open projects. Read at 10:41.",
      },
    ]);
  });

  it("in it", async () => {
    await i18n.changeLanguage("it");
    const events = asideEventsOf([
      aside({
        rows: [row()],
        hypothesis: { ticketId: "t1", taskCode: "AUD-12", key: "out_of_plan" },
      }),
    ]);
    expect(events.map((e) => (e as { text: string }).text)).toEqual([
      "AUD-12 forse è uscita dalla pianificazione: non ha una settimana",
      IT_DETAILS,
    ]);
  });

  it("soglie diverse fra i progetti mostrati, o assenti (un server di prima): la frase generica", () => {
    const mixed = asideEventsOf([
      aside({ rows: [row(), row({ projectCode: "ACQ", thresholdDays: 5 })], hypothesis: null }),
    ]);
    expect((mixed[0] as { text: string }).text).toMatch(
      /^A task counts as stalled .*Thresholds differ by project/,
    );
    const missing = asideEventsOf([
      aside({ rows: [row({ thresholdDays: undefined })], hypothesis: null }),
    ]);
    expect((missing[0] as { text: string }).text).toMatch(/Thresholds differ by project/);
  });

  it("senza ipotesi (o con una chiave che questo renderer non conosce): solo i dettagli", () => {
    expect(
      asideEventsOf([aside({ rows: [row()], hypothesis: null })]).map(
        (e) => (e as { kind: string }).kind,
      ),
    ).toEqual(["details"]);
    expect(
      asideEventsOf([
        aside({ rows: [row()], hypothesis: { ticketId: "t1", taskCode: "AUD-12", key: "nuova" } }),
      ]).map((e) => (e as { kind: string }).kind),
    ).toEqual(["details"]);
  });

  it("nessuna riga che chi guarda veda ancora, o dati illeggibili: niente sotto la risposta", () => {
    expect(asideEventsOf([aside({ rows: [], hypothesis: null })])).toEqual([]);
    expect(asideEventsOf([aside(null), aside({ rows: "x" }, "a2")])).toEqual([]);
  });

  it("gli altri eventi non c'entrano", () => {
    expect(
      asideEventsOf([{ id: "e1", at, type: "assistant_text", data: { text: "x" } } as never]),
    ).toEqual([]);
  });
});
