import type { InboxItem, Reader } from "@stubwise/shared";
import { Linking } from "react-native";
import { openActionFor } from "./open-ticket";

const TICKET_ID = "77777777-7777-4777-8777-777777777777";
const JOB_ID = "88888888-8888-4888-8888-888888888888";

function item(overrides: Partial<Reader<InboxItem>> & Pick<InboxItem, "id" | "kind">): Reader<InboxItem> {
  return {
    status: "open",
    text: "Testo dell'evento",
    actions: ["open"],
    projectId: null,
    ticketId: TICKET_ID,
    jobId: JOB_ID,
    url: "https://stubwise.example/tickets/77777777",
    createdAt: "2026-09-02T09:48:00.000Z",
    readAt: null,
    snoozedUntil: null,
    handledAt: null,
    handledBy: null,
    reviewOutcome: null,
    ...overrides,
  } as Reader<InboxItem>;
}

beforeEach(() => {
  (Linking.openURL as jest.Mock).mockClear();
});

/**
 * «Apri» di una domanda dell'agente porta alla SESSIONE che la sta facendo
 * (piano C, Task 8; gemello di `openHref` in `apps/web/src/components/inbox-item.tsx`):
 * solo per `job.awaiting_input` con `jobId` E `ticketId`, come il web.
 */
describe("openActionFor — la domanda dell'agente apre la sessione", () => {
  test("job.awaiting_input con la callback: la chiama con job e ticket, il ticket no", () => {
    const onOpenTicket = jest.fn();
    const onOpenSessionForJob = jest.fn();
    const open = openActionFor(item({ id: "q1", kind: "job.awaiting_input" }), onOpenTicket, { onOpenSessionForJob });
    expect(open).not.toBeNull();
    open!();
    expect(onOpenSessionForJob).toHaveBeenCalledWith(JOB_ID, TICKET_ID);
    expect(onOpenTicket).not.toHaveBeenCalled();
    expect(Linking.openURL).not.toHaveBeenCalled();
  });

  test("un altro kind (job.failed) con la callback: il ticket come prima", () => {
    const onOpenTicket = jest.fn();
    const onOpenSessionForJob = jest.fn();
    const open = openActionFor(item({ id: "f1", kind: "job.failed" }), onOpenTicket, { onOpenSessionForJob });
    open!();
    expect(onOpenTicket).toHaveBeenCalledWith(TICKET_ID, "status");
    expect(onOpenSessionForJob).not.toHaveBeenCalled();
  });

  test("job.awaiting_input SENZA la callback: il ticket come prima", () => {
    const onOpenTicket = jest.fn();
    openActionFor(item({ id: "q1", kind: "job.awaiting_input" }), onOpenTicket)!();
    expect(onOpenTicket).toHaveBeenCalledWith(TICKET_ID, "status");
  });

  test("senza jobId: il ticket, mai la sessione", () => {
    const onOpenTicket = jest.fn();
    const onOpenSessionForJob = jest.fn();
    openActionFor(item({ id: "q1", kind: "job.awaiting_input", jobId: null }), onOpenTicket, { onOpenSessionForJob })!();
    expect(onOpenSessionForJob).not.toHaveBeenCalled();
    expect(onOpenTicket).toHaveBeenCalledWith(TICKET_ID, "status");
  });

  test("senza ticketId (come il web): niente sessione, resta il link", () => {
    const onOpenSessionForJob = jest.fn();
    openActionFor(item({ id: "q1", kind: "job.awaiting_input", ticketId: null }), jest.fn(), { onOpenSessionForJob })!();
    expect(onOpenSessionForJob).not.toHaveBeenCalled();
    expect(Linking.openURL).toHaveBeenCalledWith("https://stubwise.example/tickets/77777777");
  });

  test("se il server non offre «Apri», non lo inventa nemmeno la sessione", () => {
    const open = openActionFor(item({ id: "q1", kind: "job.awaiting_input", actions: ["answer"] }), jest.fn(), {
      onOpenSessionForJob: jest.fn(),
    });
    expect(open).toBeNull();
  });
});
