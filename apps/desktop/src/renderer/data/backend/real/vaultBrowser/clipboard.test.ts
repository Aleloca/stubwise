import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIPBOARD_CLEAR_MS, __resetClipboardForTests, copyWithAutoClear, clearNow } from "./clipboard";

// Gli appunti nel browser (design §6, I4): dopo 30 s si svuotano se contengono
// ancora la password (o se non si possono leggere); senza fuoco
// `writeText("")` fallisce, e lo svuotamento si riprova al ritorno.

let clip: string;
let canWrite: boolean;
let canRead: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  clip = "";
  canWrite = true;
  canRead = true;
  vi.stubGlobal("navigator", {
    ...navigator,
    clipboard: {
      writeText: vi.fn(async (t: string) => {
        if (!canWrite) throw new Error("NotAllowedError");
        clip = t;
      }),
      readText: vi.fn(async () => {
        if (!canRead) throw new Error("NotAllowedError");
        return clip;
      }),
    },
  });
  __resetClipboardForTests();
});
afterEach(() => {
  __resetClipboardForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("gli appunti della cassaforte", () => {
  it("dopo 30 s si svuotano se contengono ancora la password", async () => {
    await copyWithAutoClear("s3cret");
    expect(clip).toBe("s3cret");
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(clip).toBe("");
  });

  it("se nel frattempo ci si è copiato altro, restano com'erano", async () => {
    await copyWithAutoClear("s3cret");
    clip = "other";
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(clip).toBe("other");
  });

  it("se non si possono leggere, si svuotano comunque", async () => {
    await copyWithAutoClear("s3cret");
    canRead = false;
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(clip).toBe("");
  });

  it("I4: senza fuoco lo svuotamento fallisce, e si riprova al ritorno (focus)", async () => {
    await copyWithAutoClear("s3cret");
    canWrite = false;
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(clip).toBe("s3cret");
    canWrite = true;
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(clip).toBe(""));
  });

  it("alla chiusura della cassaforte si svuotano subito", async () => {
    await copyWithAutoClear("s3cret");
    await clearNow();
    expect(clip).toBe("");
  });
});
