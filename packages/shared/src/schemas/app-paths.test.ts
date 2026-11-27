import { describe, expect, it } from "vitest";
import { readerSchema } from "../reader.js";
import { backlogJobResultSchema, convertBacklogResultSchema } from "./backlog.js";
import { ticketSchema } from "./ticket.js";

describe("ritiro del web vecchio: i percorsi della nuova app sono additivi", () => {
  it("le risposte di un server di prima (senza appPath, ticketAppPath, resultItemAppPath) si leggono", () => {
    const ticket = {
      id: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      number: 1,
      title: "t",
      body: "",
      type: "bug",
      priority: "medium",
      status: "open",
      source: "manual",
      assigneeId: null,
      milestoneId: null,
      effort: null,
      labels: [],
      technicalPayload: null,
      occurrences: 1,
      lastSeenAt: "2026-11-27T10:00:00.000Z",
      createdAt: "2026-11-27T10:00:00.000Z",
      updatedAt: "2026-11-27T10:00:00.000Z",
    };
    expect(readerSchema(ticketSchema).parse(ticket).appPath).toBeUndefined();
    expect(readerSchema(convertBacklogResultSchema).parse({ ticketId: ticket.id, ticketNumber: 1 }).ticketAppPath).toBeUndefined();
    expect(readerSchema(backlogJobResultSchema).parse({ status: "done", resultItemId: ticket.id, error: null }).resultItemAppPath).toBeUndefined();
  });
});
