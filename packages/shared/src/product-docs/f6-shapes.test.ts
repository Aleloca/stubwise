import { describe, expect, it } from "vitest";
import { readerSchema, UNKNOWN } from "../reader.js";
import { parseProductLiveFrame } from "./live.js";
import {
  firstVersionSourceSchema,
  productFirstVersionViewSchema,
  productPageViewSchema,
  productWireframeViewSchema,
} from "../schemas/product-docs.js";
import { newRequestBodySchema, projectRequestViewSchema } from "../schemas/project-request.js";
import { taskViewSchema } from "../schemas/task-view.js";
import { claudeCapabilitiesSchema } from "../schemas/claude-capabilities.js";

// Area 11, F6, Task 1: le forme nuove. Ogni campo nuovo di una risposta nasce
// con un default, e un client lo legge anche da un server che non lo manda.

const ID = "1c9e4f70-5555-4666-8777-888899990041";

describe("F6: additivo", () => {
  it("una pagina senza `wireframes` (un server di prima) si legge con []", () => {
    const page = {
      id: ID, code: "PRO-D1", projectId: ID, parentId: null, order: 0, title: "T", blocks: [], seq: 0,
      createdById: null, createdAt: "x", updatedById: null, updatedAt: "x", breadcrumbs: [], permissions: { edit: true, delete: true },
    };
    expect(readerSchema(productPageViewSchema).parse(page).wireframes).toEqual([]);
  });

  it("una richiesta senza `productOrigin` si legge null", () => {
    const req = { id: ID, code: "PRO-R1", projectId: ID, title: "T", description: "", status: "new", urgency: null, createdAt: "2026-11-21T00:00:00.000Z" };
    expect(readerSchema(projectRequestViewSchema).parse(req).productOrigin).toBeNull();
  });

  it("le capacità `product*` si leggono; un id futuro è UNKNOWN", () => {
    expect(readerSchema(claudeCapabilitiesSchema).parse({ items: ["productFirstVersion", "productChanges", "brand_new"] }).items).toEqual(["productFirstVersion", "productChanges", UNKNOWN]);
  });

  it("la task ha `productOrigin` con default null", () => {
    expect(taskViewSchema.shape.productOrigin.parse(undefined)).toBeNull();
  });
});

describe("domande aperte: additivo", () => {
  it("senza `quote` (un server di prima) si legge stringa vuota", async () => {
    const { productOpenQuestionSchema } = await import("../schemas/product-docs.js");
    expect(productOpenQuestionSchema.shape.quote.parse(undefined)).toBe("");
  });
});

describe("cronologia: il gesto sulla bozza, additivo", () => {
  it("senza `wireframe` (un server di prima) si legge null; un gesto futuro è UNKNOWN", async () => {
    const { productRevisionViewSchema } = await import("../schemas/product-docs.js");
    const rev = { id: ID, pageId: ID, sessionId: null, seq: 1, lastSeq: 1, kind: "edit", actorId: null, actorName: null, changes: [], createdAt: "x", updatedAt: "x" };
    expect(readerSchema(productRevisionViewSchema).parse(rev).wireframe).toBeNull();
    expect(readerSchema(productRevisionViewSchema).parse({ ...rev, wireframe: "erased" }).wireframe).toBe(UNKNOWN);
  });
});

describe("F6: le forme", () => {
  it("la prima versione: uno stato futuro è UNKNOWN; senza `permissions.stop` e senza `stopping` sono false; l'«Undo» senza la pagina toccata", () => {
    const view = readerSchema(productFirstVersionViewSchema).parse({
      projectId: ID, groupId: ID, byId: null, byName: null, status: "brand_new", pagesDone: 1, pagesTotal: 3, interrupted: false,
      sources: [{ kind: "drive", canOpen: true, id: ID, title: "Spec", code: "PRO-F1", ownerId: null, ownerName: null, at: null, gone: false }],
      pages: [{ title: "Overview", depth: 0, pageId: ID, code: "PRO-D1", state: "written" }],
      acceptedPageIds: [], bannerPageIds: [ID], undo: { enabled: true }, permissions: { edit: true },
    });
    expect(view).toMatchObject({ status: UNKNOWN, stopping: false, permissions: { stop: false }, undo: { pageId: null, touch: null }, sources: [{ kind: "drive" }] });
  });

  it("una fonte di testo vuota passa lo schema (il server la salta); una fonte sconosciuta no", () => {
    expect(firstVersionSourceSchema.safeParse({ kind: "text", text: "" }).success).toBe(true);
    expect(firstVersionSourceSchema.safeParse({ kind: "chat", id: ID }).success).toBe(false);
  });

  it("una bozza: lo stato futuro è UNKNOWN, `error` di default null", () => {
    expect(readerSchema(productWireframeViewSchema).parse({ id: ID, status: "brand_new", variants: [{ svg: "<svg/>" }] })).toMatchObject({ status: UNKNOWN, error: null });
  });

  it("il frame `wireframe` dello stream si legge", () => {
    expect(parseProductLiveFrame(`data: ${JSON.stringify({ type: "wireframe", wireframeId: ID, status: "ready" })}\n\n`)).toEqual([{ type: "wireframe", wireframeId: ID, status: "ready" }]);
  });

  it("l'origine di una richiesta: con la domanda, o dalla sola pagina", () => {
    const base = { projectId: ID, title: "T", description: "" };
    expect(newRequestBodySchema.safeParse({ ...base, origin: { kind: "product_doc", pageId: ID, anchorId: "blk-1", questionId: ID } }).success).toBe(true);
    expect(newRequestBodySchema.safeParse({ ...base, origin: { kind: "product_doc", pageId: ID, anchorId: "blk-1" } }).success).toBe(true);
    expect(newRequestBodySchema.safeParse({ ...base, origin: { kind: "support", pageId: ID, anchorId: "blk-1" } }).success).toBe(false);
  });
});

describe("F6, Task 4: le voci di Claude sulla doc e le sue letture", () => {
  it("le sei voci: B, con gli argomenti del prototipo, e nelle firme del prompt", async () => {
    const { CLAUDE_ACTION_ARGS, CLAUDE_DECLARED_CLASS, CLAUDE_PROPOSABLE_FNS, claudeActionSignatures } = await import("../schemas/claude-actions.js");
    const fns = ["writeFirstVersion", "undoFirstVersion", "updateProductPage", "undoProductUpdate", "drawWireframe", "deleteWireframe"] as const;
    for (const fn of fns) {
      expect(CLAUDE_DECLARED_CLASS[fn]).toBe("B");
      expect(CLAUDE_PROPOSABLE_FNS).toContain(fn);
      expect(claudeActionSignatures()).toContain(`- ${fn}(`);
    }
    expect(CLAUDE_ACTION_ARGS.writeFirstVersion.safeParse({ projectId: ID, sources: [{ kind: "text", text: "note" }] }).success).toBe(true);
    expect(CLAUDE_ACTION_ARGS.writeFirstVersion.safeParse({ projectId: ID, sources: [] }).success).toBe(false);
    expect(CLAUDE_ACTION_ARGS.updateProductPage.safeParse({ pageId: ID, source: { kind: "meeting", id: ID } }).success).toBe(true);
    // Solo un'email o una riunione: un file del Drive no.
    expect(CLAUDE_ACTION_ARGS.updateProductPage.safeParse({ pageId: ID, source: { kind: "drive", fileId: ID } }).success).toBe(false);
    expect(CLAUDE_ACTION_ARGS.drawWireframe.safeParse({ pageId: ID }).success).toBe(true);
    expect(CLAUDE_ACTION_ARGS.drawWireframe.safeParse({ pageId: ID, afterId: null }).success).toBe(true);
    expect(CLAUDE_ACTION_ARGS.drawWireframe.safeParse({ pageId: ID, afterId: "blk-1", replaceId: "blk-2" }).success).toBe(false);
    expect(CLAUDE_ACTION_ARGS.deleteWireframe.safeParse({ pageId: ID, blockId: "blk-1", revisionId: ID, extra: 1 }).success).toBe(false);
  });

  it("i cambi della doc: senza `more`, `source` e i nomi (un server di prima) si leggono coi default", async () => {
    const { productChangesSchema } = await import("../schemas/product-docs.js");
    const item = { revisionId: ID, pageId: ID, pageCode: "PRO-D1", pageTitle: "T", projectId: ID, kind: "claude", at: "x" };
    expect(readerSchema(productChangesSchema).parse({ items: [item] })).toMatchObject({ more: false, items: [{ via: null, actorName: null, onBehalfOfName: null, source: null }] });
    expect(readerSchema(productChangesSchema).parse({ items: [{ ...item, kind: "brand_new" }] }).items[0]!.kind).toBe(UNKNOWN);
  });

  it("i tool della chat sulla doc: nell'elenco, con le rotte nell'allowlist", async () => {
    const { CHAT_READ_TOOLS } = await import("../schemas/claude-conversation.js");
    const { CHAT_TOOL_READ_ROUTES } = await import("../chat-tool-routes.js");
    expect(CHAT_READ_TOOLS).toEqual(expect.arrayContaining(["read_product_page", "read_product_changes"]));
    expect(CHAT_TOOL_READ_ROUTES.has("/api/product-pages/by-code/:code")).toBe(true);
    expect(CHAT_TOOL_READ_ROUTES.has("/api/product-changes")).toBe(true);
  });
});
