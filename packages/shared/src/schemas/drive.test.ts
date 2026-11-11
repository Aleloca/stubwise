import { describe, expect, it } from "vitest";
import { DRIVE_FILE_MAX_BYTES, driveFileDetailSchema, driveFileRowSchema, driveFileTypeOf, driveListQuerySchema } from "./drive.js";
import { CHAT_CITATION_KINDS, chatCitationSchema } from "./chat.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("il Drive (area 5, fetta 2)", () => {
  it("il tipo si deduce dal MIME, come il prototipo", () => {
    expect(driveFileTypeOf("application/pdf")).toBe("pdf");
    expect(driveFileTypeOf("image/png")).toBe("image");
    expect(driveFileTypeOf("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("document");
    expect(driveFileTypeOf("application/vnd.oasis.opendocument.text")).toBe("document");
    expect(driveFileTypeOf("text/markdown")).toBe("document");
    expect(driveFileTypeOf("text/csv")).toBe("sheet");
    expect(driveFileTypeOf("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("sheet");
    expect(driveFileTypeOf("application/vnd.ms-powerpoint")).toBe("slides");
    expect(driveFileTypeOf("video/mp4")).toBe("other");
    expect(driveFileTypeOf("application/zip")).toBe("other");
    expect(DRIVE_FILE_MAX_BYTES).toBe(100 * 1024 * 1024);
  });

  it("una riga e un dettaglio con i soli campi di base si leggono coi default", () => {
    const row = driveFileRowSchema.parse({
      id: ID,
      code: "AUD-F1",
      projectId: ID,
      name: "Contratto.pdf",
      mime: "application/pdf",
      type: "pdf",
      sizeBytes: 10,
      addedById: null,
      addedAt: "2026-11-11T10:00:00.000Z",
    });
    expect(row).toMatchObject({ source: "upload", opens90d: 0, lastOpenedAt: null, summaryLine: null, projectCode: null });
    expect(row.permissions).toEqual({ delete: false, remove: false, hide: false, retry: false });
    expect(driveFileDetailSchema.parse({ ...row, opensTotal: 3 }).history).toBeNull();
  });

  it("l'elenco ordina per «Più usati» di default; un ordinamento ignoto è un errore", () => {
    expect(driveListQuerySchema.parse({}).sort).toBe("most_used");
    expect(() => driveListQuerySchema.parse({ sort: "boh" })).toThrow();
  });

  it("le citazioni hanno il kind drive, e la vista di un file la sua scheda (default null)", () => {
    expect(CHAT_CITATION_KINDS).toContain("drive");
    const c = chatCitationSchema.parse({ kind: "drive", id: ID, label: "Contratto.pdf" });
    expect(c.drive).toBeNull();
  });
});
