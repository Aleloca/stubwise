import { describe, expect, it } from "vitest";
import { readerSchema } from "../reader.js";
import { mailDraftRestoreSchema } from "./mail-compose.js";

describe("mailDraftRestoreSchema.gmailOutdated (registro, A6 r.448) — additivo", () => {
  it("un server più vecchio non lo manda: false", () => {
    const parsed = readerSchema(mailDraftRestoreSchema).parse({ draft: null, droppedAttachments: [], unsaved: false });
    expect(parsed.gmailOutdated).toBe(false);
  });

  it("quando c'è, passa", () => {
    expect(readerSchema(mailDraftRestoreSchema).parse({ draft: null, gmailOutdated: true }).gmailOutdated).toBe(true);
  });
});

describe("mailDraftRestoreSchema.gmailCopyKept (revisione del lotto 2, I5) — additivo", () => {
  it("un server più vecchio non lo manda: false", () => {
    expect(readerSchema(mailDraftRestoreSchema).parse({ draft: null, gmailOutdated: false }).gmailCopyKept).toBe(false);
  });

  it("quando c'è, passa", () => {
    expect(readerSchema(mailDraftRestoreSchema).parse({ draft: null, gmailCopyKept: true }).gmailCopyKept).toBe(true);
  });
});
