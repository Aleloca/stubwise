import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inboxItemSchema, notificationKindSchema, type InboxItem } from "@stubwise/shared";
import { PROJECT_ID } from "./fakeServer";
import { presentInboxItem } from "./notifications";

// Inventario del ritiro §1.1 (c): nessuna card dell'inbox apre il web vecchio
// («Open in web»). Ogni kind del catalogo, in ogni forma in cui può arrivare
// (col link dell'app, con un percorso del web vecchio di una card di prima,
// con un URL esterno, senza link, con una task che chi legge non vede, senza
// progetto), si apre in una pagina della nuova app: il link derivato, o la
// pagina più vicina (la task, il progetto, la Home).

const TICKET = "44444444-4444-4444-8444-444444444444";
const ORIGIN = "https://stubwise.example.com";

function card(kind: string, over: Record<string, unknown>): InboxItem {
  return inboxItemSchema.parse({
    id: "33333333-3333-4333-8333-333333333333",
    status: "open",
    text: "A card",
    actions: ["open"],
    projectId: PROJECT_ID,
    ticketId: TICKET,
    jobId: null,
    createdAt: "2026-11-09T10:00:00.000Z",
    readAt: null,
    snoozedUntil: null,
    handledAt: null,
    handledBy: null,
    kind,
    ...over,
  });
}

const SHAPES: { name: string; over: Record<string, unknown> }[] = [
  { name: "col link dell'app", over: { url: `${ORIGIN}/#/p/AUD/tasks?task=AUD-12` } },
  { name: "col percorso del web vecchio (card di prima)", over: { url: `/tickets/${TICKET}` } },
  { name: "con un URL esterno (la PR, Gmail)", over: { url: "https://github.com/acme/app/pull/7" } },
  { name: "senza link", over: { url: "" } },
  { name: "con una task che chi legge non vede", over: { url: "", ticketId: "55555555-5555-4555-8555-555555555555" } },
  { name: "senza progetto né task", over: { url: "", ticketId: null, projectId: null } },
];

const ctx = {
  instanceOrigin: ORIGIN,
  taskCodes: new Map([[TICKET, "AUD-12"]]),
  projectCodes: new Map([[PROJECT_ID, "AUD"]]),
};

beforeEach(() => vi.stubEnv("VITE_STUBWISE_BUILD", "app"));
afterEach(() => vi.unstubAllEnvs());

describe("le card dell'inbox si aprono nella nuova app, mai nel web vecchio", () => {
  for (const kind of notificationKindSchema.options) {
    it(`${kind}: in ogni forma, un link dell'app e nessun «Open in web»`, () => {
      for (const shape of SHAPES) {
        const n = presentInboxItem(card(kind, shape.over), ctx);
        expect(n, `${kind} ${shape.name}`).not.toHaveProperty("webHref");
        // Una card che per scelta non apre niente lo dice (l'ingresso annullato
        // di member.added, un oggetto sparito); tutte le altre aprono una pagina.
        if (n.notOpenable || n.objectGone) continue;
        expect(n.link, `${kind} ${shape.name}`).toMatch(/^#\//);
      }
    });
  }

  it("la pagina più vicina: la task se c'è, poi il progetto, poi la Home", () => {
    // Un kind con un link esterno e una task: la task (la PR si legge lì).
    expect(presentInboxItem(card("job.pr_opened", { url: "https://github.com/acme/app/pull/7" }), ctx).link).toBe(
      "#/p/AUD/tasks?task=AUD-12",
    );
    // Una task che chi legge non vede: il progetto.
    expect(
      presentInboxItem(card("ticket.activity", { url: "", ticketId: "55555555-5555-4555-8555-555555555555" }), ctx).link,
    ).toBe("#/p/AUD");
    // Niente progetto né task: la Home.
    expect(presentInboxItem(card("security.alert", { url: "", ticketId: null, projectId: null }), ctx).link).toBe(
      "#/home",
    );
  });

  it("un link dell'app di una pagina accesa si apre lì; uno di un'altra origine no", () => {
    const chat = presentInboxItem(card("chat.question", { url: `${ORIGIN}/#/chat/ch-1?message=m-1`, ticketId: null }), ctx);
    expect(chat.link).toBe("#/chat/ch-1?message=m-1");
    // Lo stesso indirizzo da un'altra origine non è dell'istanza: la pagina più vicina.
    const evil = presentInboxItem(card("chat.question", { url: "https://evil.example.com/#/chat/ch-1", ticketId: null }), ctx);
    expect(evil.link).toBe("#/p/AUD");
  });
});
