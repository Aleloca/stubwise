import { describe, expect, it } from "vitest";
import {
  chatChannelNameSchema,
  chatChannelSchema,
  chatMessageHitSchema,
  chatMessageSchema,
  chatQuestionSchema,
  chatSearchQuerySchema,
  createChatChannelSchema,
  openChatDmSchema,
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

  it("fetta 2: un canale della fetta 1 (senza i permessi nuovi) si legge: canRead vero, gli altri falsi", () => {
    const ch = chatChannelSchema.parse({
      id: ID,
      kind: "project",
      projectId: ID,
      name: "general",
      createdAt: "2026-11-10T10:00:00.000Z",
    });
    expect(ch.canRead).toBe(true);
    expect([ch.canEditInfo, ch.canEditTopic, ch.canEditEvents, ch.canInvite, ch.canRemove, ch.canArchive, ch.canDelete]).toEqual([
      false, false, false, false, false, false, false,
    ]);
  });

  it("fetta 2: un messaggio senza i campi nuovi si legge con i default", () => {
    const m = chatMessageSchema.parse({
      id: ID,
      channelId: ID,
      authorId: ID,
      text: "ciao",
      createdAt: "2026-11-10T10:00:00.000Z",
    });
    expect(m).toMatchObject({ alsoInChannel: false, asksReplyOf: [], linked: [], linkedCodes: [], citations: [] });
    const hit = chatMessageHitSchema.parse({ channelId: ID, message: m });
    expect(hit).toMatchObject({ context: null, root: null });
  });

  it("fetta 2: generale senza progetto, privato con invitati, DM fino a 8, ricerca e domanda", () => {
    expect(createChatChannelSchema.parse({ name: "annunci" })).toMatchObject({ visibility: "open" });
    expect(createChatChannelSchema.parse({ projectId: null, name: "segreti", visibility: "private", memberIds: [ID] }).memberIds).toEqual([ID]);
    expect(() => openChatDmSchema.parse({ personIds: [] })).toThrow();
    expect(openChatDmSchema.parse({ personIds: Array.from({ length: 8 }, () => ID) }).personIds).toHaveLength(8);
    expect(() => openChatDmSchema.parse({ personIds: Array.from({ length: 9 }, () => ID) })).toThrow();
    expect(postChatMessageSchema.parse({ text: "ok?", asksReply: true, alsoInChannel: true })).toMatchObject({ asksReply: true });
    expect(() => chatSearchQuerySchema.parse({ q: "x", from: "10/11/2026" })).toThrow();
    expect(chatQuestionSchema.parse({ id: `chat:${ID}`, channelId: ID, messageId: ID, rootId: ID, askedById: ID, text: "?", createdAt: "2026-11-10T10:00:00.000Z" }).rootId).toBe(ID);
    expect(notificationKindSchema.options).toContain("chat.question");
  });
});
