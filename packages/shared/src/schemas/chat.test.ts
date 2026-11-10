import { describe, expect, it } from "vitest";
import {
  chatChannelNameSchema,
  chatChannelSchema,
  chatMessageSchema,
  createChatChannelSchema,
  postChatMessageSchema,
} from "./chat.js";
import { inboxItemSchema, notificationKindSchema } from "./notification.js";

// Area 4, Chat, fetta 1: le viste nascono coi default (un server più vecchio
// non manda i campi), i nomi dei canali seguono la regola del prototipo.
const ID = "6f1c2a52-1d7b-4c3e-9a51-0b6a7f2e1a01";

describe("gli schemi della Chat", () => {
  it("un canale e un messaggio minimi si leggono, coi default", () => {
    expect(chatChannelSchema.parse({ id: ID, kind: "project", projectId: ID, name: "general", createdAt: "2026-11-10T10:00:00.000Z" })).toMatchObject({
      visibility: "open",
      isGeneral: false,
      canWrite: false,
      canManage: false,
      unread: 0,
      mentions: 0,
      level: "all",
      memberIds: [],
    });
    expect(chatMessageSchema.parse({ id: ID, channelId: ID, authorId: null, text: "", createdAt: "2026-11-10T10:00:00.000Z" })).toMatchObject({
      threadRootId: null,
      kind: "person",
      deleted: false,
      reactions: [],
      replyCount: 0,
      canEdit: false,
      canDelete: false,
      viaClaude: false,
    });
  });

  it("il nome di un canale: minuscole, trattini al posto degli spazi, al più 40", () => {
    expect(chatChannelNameSchema.parse("  Rilasci Web ")).toBe("rilasci-web");
    expect(() => chatChannelNameSchema.parse("con#cancelletto")).toThrow();
    expect(() => chatChannelNameSchema.parse("a".repeat(41))).toThrow();
    expect(createChatChannelSchema.parse({ projectId: ID, name: "Grafica" }).name).toBe("grafica");
    expect(() => postChatMessageSchema.parse({ text: "   " })).toThrow();
  });

  it("chat.mention è un kind; una card d'inbox di prima si legge con chat null", () => {
    expect(notificationKindSchema.options).toContain("chat.mention");
    const card = inboxItemSchema.parse({
      id: ID,
      kind: "task.assigned",
      status: "open",
      text: "x",
      actions: [],
      projectId: null,
      ticketId: null,
      jobId: null,
      createdAt: "2026-11-10T10:00:00.000Z",
      readAt: null,
      snoozedUntil: null,
      handledAt: null,
      handledBy: null,
    });
    expect(card.chat).toBeNull();
  });
});
