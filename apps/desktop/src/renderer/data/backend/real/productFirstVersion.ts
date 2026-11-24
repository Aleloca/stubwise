import { ApiError } from "@stubwise/api-client";
import type * as Fake from "../../api";
import type { ProductFirstVersionView, ProductUndoView } from "../../types";
import { appClient } from "./client";
import { sourceViewFrom, undoViewFrom, type ServerSourceView } from "./productClaude";

// La prima versione nella build app (area 11, F6; R11-6), sulle forme di 72
// (a2e2bd051, rotte d1b9848f3):
// - le fonti che chi lancia vede (`firstVersionSources`);
// - lo stato (`firstVersion`), che non ha un evento: lo rilegge
//   `useProductFirstVersion` ogni 2 s mentre scrive, e con lui lo spazio;
// - «Write the first version» (202 col gruppo), «Undo the first version»
//   (409 con la pagina toccata e come), «Accept this page»;
// - «Stop» (a7f558344): 204 anche se non c'è niente da fermare; `stopping`
//   nella vista fra il clic e l'arresto.
// Gli errori sono nelle parole del prototipo (`data/productDocs/firstVersion.ts`).
// Dietro `product-claude-actions`, acceso il 22 nov 2026.

type ProductDocs = typeof Fake.productDocs;

const TOUCHES = ["edit", "comment", "answer", "page"] as const;

function firstVersionUndoFrom(u: {
  enabled: boolean;
  reason: string | null;
  byId: string | null;
  pageId: string | null;
  pageTitle: string | null;
  touch: string | null;
}): ProductUndoView {
  const base = undoViewFrom(u);
  if (base.enabled) return base;
  return {
    ...base,
    ...(u.pageId ? { pageId: u.pageId } : {}),
    ...(u.pageTitle ? { pageTitle: u.pageTitle } : {}),
    ...((TOUCHES as readonly string[]).includes(u.touch ?? "")
      ? { touch: u.touch as (typeof TOUCHES)[number] }
      : {}),
  };
}

const notThere = (error: unknown) =>
  error instanceof ApiError && (error.status === 404 || error.status === 403);

function mapFirstVersionError(error: unknown): never {
  if (error instanceof ApiError) {
    const d = (error.details ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : null);
    if (
      error.status === 409 &&
      (error.code === "changed_after" || error.code === "already_undone")
    ) {
      const touch = str("touch");
      throw Object.assign(new Error(`refused: ${error.code}`), {
        byId: str("byId"),
        ...(str("pageId") ? { pageId: str("pageId") } : {}),
        ...(str("pageTitle") ? { pageTitle: str("pageTitle") } : {}),
        ...((TOUCHES as readonly string[]).includes(touch ?? "") ? { touch } : {}),
      });
    }
    // Il budget finito: `budget_exhausted` dal server di oggi (D-7.1, review del
    // lotto 4), `ai_blocked` da uno più vecchio; per il prototipo è `ai_blocked`.
    if (error.code === "budget_exhausted" || error.code === "ai_blocked") throw new Error("ai_blocked");
    if (error.code === "space_not_empty" || error.code === "no_sources") throw new Error(error.code);
    if (error.code === "invalid_source") throw new Error("invalid: source");
    if (error.code === "invalid_page") throw new Error("invalid: page");
    if (error.status === 403) throw new Error("forbidden");
    if (error.status === 404) throw new Error("not_found");
  }
  throw error;
}

export const liveProductFirstVersion: Partial<ProductDocs> = {
  async listFirstVersionSources(projectId) {
    try {
      const s = await appClient().productDocs.firstVersionSources(projectId);
      return {
        emails: s.emails.map((e) => ({
          id: e.id,
          fromName: e.fromName,
          subject: e.subject,
          at: e.at,
        })),
        meetings: s.meetings.map((m) => ({
          id: m.id,
          title: m.title,
          at: m.at,
          transcript: m.transcript,
        })),
        files: s.files.map((f) => ({
          id: f.id,
          code: f.code,
          name: f.name,
          type: f.type as Awaited<
            ReturnType<ProductDocs["listFirstVersionSources"]>
          >["files"][number]["type"],
        })),
      };
    } catch (error) {
      if (notThere(error)) return { emails: [], meetings: [], files: [] };
      throw error;
    }
  },

  async getProductFirstVersion(projectId) {
    let v: Awaited<ReturnType<ReturnType<typeof appClient>["productDocs"]["firstVersion"]>>;
    try {
      v = await appClient().productDocs.firstVersion(projectId);
    } catch (error) {
      if (notThere(error)) return null;
      throw error;
    }
    if (!v) return null;
    const status = v.status === "done" || v.status === "undone" ? v.status : "writing";
    const view: ProductFirstVersionView = {
      projectId: v.projectId,
      groupId: v.groupId,
      byId: v.byId ?? "",
      byName: v.byName,
      status,
      pagesDone: v.pagesDone,
      pagesTotal: v.pagesTotal,
      interrupted: v.interrupted,
      sources: v.sources.map((s) => sourceViewFrom(s as ServerSourceView)),
      pages: v.pages.map((p) => ({
        title: p.title,
        depth: p.depth,
        pageId: p.pageId,
        code: p.code,
        state: p.state === "written" || p.state === "writing" ? p.state : "waiting",
      })),
      acceptedPageIds: v.acceptedPageIds,
      bannerPageIds: v.bannerPageIds,
      undo: firstVersionUndoFrom(v.undo),
      // «Stop» (72, a7f558344): `stopping` fra il clic e l'arresto; un
      // server più vecchio non lo dà.
      stopping: v.stopping ?? false,
      permissions: { edit: v.permissions.edit, stop: v.permissions.stop ?? false },
    };
    return view;
  },

  async startFirstVersion(projectId, sources) {
    try {
      return await appClient().productDocs.startFirstVersion(
        projectId,
        sources as Parameters<ReturnType<typeof appClient>["productDocs"]["startFirstVersion"]>[1],
      );
    } catch (error) {
      return mapFirstVersionError(error);
    }
  },

  async undoFirstVersion(projectId) {
    try {
      await appClient().productDocs.undoFirstVersion(projectId);
    } catch (error) {
      mapFirstVersionError(error);
    }
  },

  async stopFirstVersion(projectId) {
    try {
      await appClient().productDocs.stopFirstVersion(projectId);
    } catch (error) {
      mapFirstVersionError(error);
    }
  },

  async acceptFirstVersionPage(pageId) {
    try {
      await appClient().productDocs.acceptFirstVersionPage(pageId);
    } catch (error) {
      mapFirstVersionError(error);
    }
  },

  // Nessun evento della prima versione nella build app: la rilegge
  // `useProductFirstVersion` ogni 2 s mentre scrive. L'iscrizione non chiama niente.
  onProductFirstVersion() {
    return () => undefined;
  },
};
