import { readerSchema, waitingCustomersResponseSchema } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { createRealWaiting } from "./mailWaiting";

// Area 8, «Clienti in attesa» nell'app: `client.mail.waitingCustomers()` (72)
// nelle forme del prototipo (`mail.listWaitingCustomers`). Il motivo di
// Claude solo con `yes` (testo, non fidato); un giudizio che l'app non
// conosce vale «da valutare»; `total` assente vale 0.

const ROW = {
  threadId: "th-1",
  accountId: "11111111-1111-4111-8111-111111111111",
  accountEmail: "giulia@stubwise.test",
  customer: { name: "Anna Verdi", email: "anna@cliente.test" },
  subject: "Fattura di ottobre",
  project: { id: "22222222-2222-4222-8222-222222222222", code: "AUD", name: "Audin" },
  waitingSince: "2026-11-14T10:00:00.000Z",
  signal: "request",
  importance: "normal",
  judgment: "yes",
  reason: "Asks for the invoice.",
};

const real = (body: unknown) =>
  createRealWaiting({
    // Come il client: `readerSchema` apre gli enum (un valore ignoto è UNKNOWN).
    waitingCustomers: async () => readerSchema(waitingCustomersResponseSchema).parse(body),
  });

describe("Clienti in attesa nell'app", () => {
  it("le righe nella forma del prototipo, col totale", async () => {
    const out = await real({ items: [ROW], total: 3 }).listWaitingCustomers();
    // Review C1: il thread si apre per casella, come le altre righe della Posta.
    expect(out).toEqual({ items: [{ ...ROW, threadId: `${ROW.accountId}_th-1` }], total: 3 });
  });

  it("un giudizio ignoto vale «da valutare» e non porta motivo; `total` assente vale 0", async () => {
    const out = await real({
      items: [{ ...ROW, judgment: "maybe", reason: "should not show" }],
    }).listWaitingCustomers();
    expect(out.total).toBe(0);
    expect(out.items[0]).toMatchObject({ judgment: "pending", reason: null });
  });

  it("i campi facoltativi assenti: nessun oggetto, nessun nome, nessuna importanza", async () => {
    const rest: Record<string, unknown> = { ...ROW };
    for (const k of ["subject", "signal", "importance"]) delete rest[k];
    const out = await real({
      items: [{ ...rest, customer: { email: "anna@cliente.test" }, judgment: "pending" }],
      total: 1,
    }).listWaitingCustomers();
    expect(out.items[0]).toMatchObject({
      subject: null,
      signal: null,
      importance: null,
      customer: { name: null, email: "anna@cliente.test" },
      reason: null,
    });
  });
});
