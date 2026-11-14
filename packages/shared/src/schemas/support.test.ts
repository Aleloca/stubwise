import { describe, expect, it } from "vitest";
import { readerSchema } from "../reader.js";
import { projectRequestViewSchema } from "./project-request.js";
import {
  supportConversationListSchema,
  supportConversationSchema,
  supportCustomerPreviewSchema,
  supportEmailDraftSchema,
  supportOpenRequestBodySchema,
  supportOpenRequestResultSchema,
  supportReplyBodySchema,
} from "./support.js";
import { taskViewSchema } from "./task-view.js";

// Area 8, F3: le forme di Support (accordo con 94). Ogni campo facoltativo ha
// il suo default: una risposta di un server più vecchio, o più povera, si
// legge lo stesso (la regola dei campi additivi).

const P = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
/** Il minimo che un server manda: solo i campi obbligatori. */
const minimal = {
  id: C,
  code: "ACQ-S2",
  projectId: P,
  projectCode: "ACQ",
  channel: "widget",
  state: "triage",
  createdAt: "2026-11-14T10:00:00.000Z",
  lastMessageAt: "2026-11-14T10:05:00.000Z",
};

describe("supportConversationSchema", () => {
  it("una vista con i soli campi obbligatori: tutto il resto ha un default che non concede niente", () => {
    const v = supportConversationSchema.parse(minimal);
    expect(v).toMatchObject({
      widgetId: null,
      widgetName: null,
      customer: { name: null, email: null },
      messages: [],
      lastMessage: null,
      waitingSince: null,
      rewrittenWish: null,
      confirmedAt: null,
      triage: null,
      request: null,
      task: null,
      claudeDraft: null,
      claudeDraftAt: null,
      claudeDraftPending: false,
      following: false,
      canReply: false,
      replyClosed: null,
      canOpenRequest: false,
      canMarkNotConcluded: false,
      emailBlocked: null,
    });
  });

  it("il giudizio porta il suo autore (null = il controllo del worker)", () => {
    const v = supportConversationSchema.parse({ ...minimal, state: "answered", triage: { outcome: "concluded", at: "2026-11-14T10:20:00.000Z" } });
    expect(v.triage).toEqual({ outcome: "concluded", at: "2026-11-14T10:20:00.000Z", byUserId: null });
  });

  it("uno stato o un canale sconosciuti (un server più nuovo) non fanno crollare l'elenco nel client", () => {
    const parsed = readerSchema(supportConversationListSchema).parse({ items: [{ ...minimal, state: "snoozed", channel: "slack" }] });
    expect(parsed.items).toHaveLength(1);
  });
});

describe("le altre forme", () => {
  it("anteprima del cliente: solo «customer» e «us», mai un nome", () => {
    const p = supportCustomerPreviewSchema.parse({ status: "received", messages: [{ from: "us", body: "Ciao", at: minimal.createdAt }] });
    expect(Object.keys(p.messages[0]!)).toEqual(["from", "body", "at"]);
  });

  it("la risposta: un testo non vuoto, `clientId` facoltativo", () => {
    expect(supportReplyBodySchema.safeParse({ body: "  " }).success).toBe(false);
    expect(supportReplyBodySchema.parse({ body: " Ciao " })).toEqual({ body: "Ciao" });
  });

  it("la richiesta da una conversazione e il suo esito", () => {
    expect(supportOpenRequestBodySchema.safeParse({ title: "", description: "" }).success).toBe(false);
    const r = supportOpenRequestResultSchema.parse({ conversation: minimal, request: { id: P, code: "ACQ-R14" } });
    expect(r.request.code).toBe("ACQ-R14");
  });

  it("la bozza email: lo slot della conversazione", () => {
    const d = supportEmailDraftSchema.parse({ slot: "support-ACQ-S2", to: { email: "m@x.it" }, subject: "s", body: "b" });
    expect(d.to).toEqual({ name: null, email: "m@x.it" });
  });

  it("la provenienza di una richiesta e la conversazione di una task: assenti → null (server più vecchio)", () => {
    const req = projectRequestViewSchema.parse({
      id: P,
      code: "ACQ-R1",
      projectId: P,
      title: "t",
      description: "",
      status: "new",
      urgency: null,
      createdAt: minimal.createdAt,
      webHref: "/requests/x",
    });
    expect(req.origin).toBeNull();
    const shape = taskViewSchema.shape as Record<string, unknown>;
    expect(shape["supportConversationCode"]).toBeDefined();
    expect((taskViewSchema.shape.supportConversationCode as { parse: (v: unknown) => unknown }).parse(undefined)).toBeNull();
  });
});
