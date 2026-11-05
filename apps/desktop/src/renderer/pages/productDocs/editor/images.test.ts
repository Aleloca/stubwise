import { describe, expect, it } from "vitest";
import { PRODUCT_IMAGE_MAX_BYTES, PRODUCT_IMAGE_TYPES, readImageFile } from "./images";

// Un file in un blocco immagine (shape product-editor.md §3.6, [PE 9]):
// sempre un `data:` URL, al più 5 MB, solo PNG, JPEG, GIF e WebP.

const bytes = (n: number) => new Uint8Array(n);

describe("readImageFile", () => {
  it("un PNG di 10 KB diventa un data:image/png, col nome senza estensione come testo alternativo", async () => {
    const out = await readImageFile(new File([bytes(10 * 1024)], "sign-in screen.png", { type: "image/png" }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.src.startsWith("data:image/png")).toBe(true);
    expect(out.alt).toBe("sign-in screen");
  });

  it("6 MB: too_large, senza leggerlo", async () => {
    const out = await readImageFile(new File([bytes(6 * 1024 * 1024)], "big.png", { type: "image/png" }));
    expect(out).toEqual({ ok: false, reason: "too_large" });
  });

  it("esattamente 5 MB passa", async () => {
    const out = await readImageFile(new File([bytes(PRODUCT_IMAGE_MAX_BYTES)], "edge.webp", { type: "image/webp" }));
    expect(out.ok).toBe(true);
  });

  it("un PDF: unsupported (anche se grande: il tipo si dice prima)", async () => {
    expect(await readImageFile(new File([bytes(100)], "brief.pdf", { type: "application/pdf" }))).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(
      await readImageFile(new File([bytes(6 * 1024 * 1024)], "brief.pdf", { type: "application/pdf" })),
    ).toEqual({ ok: false, reason: "unsupported" });
  });

  it("un SVG non è fra i tipi (può portare script)", async () => {
    expect(PRODUCT_IMAGE_TYPES).not.toContain("image/svg+xml");
    expect(await readImageFile(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }))).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });
});
