import { afterEach, describe, expect, it, vi } from "vitest";
import { setAppClientForTests } from "./client";
import { mail } from "./mail";

// Le immagini delle email nella build app, dal proxy del server: i byte
// diventano un `data:` che il frame mette in `src`; nient'altro entra.

const ID = "11111111-1111-4111-8111-111111111111";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

afterEach(() => {
  setAppClientForTests(null);
  vi.unstubAllGlobals();
});

function serve(status: number, body: BodyInit | null, type: string) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(body, { status, headers: { "content-type": type } });
  }));
  return seen;
}

describe("mail.getMessageImage (build app)", () => {
  it("la posizione n del messaggio, per percorso; i byte come data: PNG", async () => {
    const seen = serve(200, PNG, "image/png");
    const data = await mail.getMessageImage(ID, 2);
    expect(data).toMatch(/^data:image\/png;base64,/);
    expect(seen).toEqual([`/api/me/mail/email_triage/${ID}/images/2`]);
  });

  it("un 422 (immagine non disponibile) o un tipo che non è un raster ammesso: null", async () => {
    serve(422, JSON.stringify({ code: "image_unavailable" }), "application/json");
    expect(await mail.getMessageImage(ID, 0)).toBeNull();
    serve(200, "<svg/>", "image/svg+xml");
    expect(await mail.getMessageImage(ID, 0)).toBeNull();
  });
});
