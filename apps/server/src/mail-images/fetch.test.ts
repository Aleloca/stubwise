import { describe, expect, it, vi } from "vitest";
import { fetchRemoteImage, IMAGE_PROXY_USER_AGENT, type ImageFetchDeps, type RemoteResponse } from "./fetch.js";

// Il fetch del proxy delle immagini (design §3–§5), con DNS e connessione
// finti: nessuna richiesta di rete vera.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);

function response(over: Partial<RemoteResponse> & { chunks?: Buffer[] } = {}): RemoteResponse {
  const chunks = over.chunks ?? [PNG];
  return {
    status: over.status ?? 200,
    headers: over.headers ?? { "content-type": "image/png" },
    body: over.body ?? (async function* () {
      for (const c of chunks) yield c;
    })(),
  };
}

function deps(over: Partial<ImageFetchDeps> = {}): ImageFetchDeps & { requests: { url: string; address: string; headers: Record<string, string> }[] } {
  const requests: { url: string; address: string; headers: Record<string, string> }[] = [];
  return {
    requests,
    resolve: over.resolve ?? (async () => ["93.184.216.34"]),
    request:
      over.request ??
      (async (req) => {
        requests.push({ url: req.url.href, address: req.address, headers: req.headers });
        return response();
      }),
    totalMs: over.totalMs ?? 8000,
  };
}

describe("fetchRemoteImage", () => {
  it("un'immagine pubblica: si connette all'IP risolto e controllato, col tipo deciso dai byte", async () => {
    const d = deps();
    const out = await fetchRemoteImage("https://cdn.example/logo.png", d);
    expect(out).toEqual({ ok: true, contentType: "image/png", bytes: PNG });
    expect(d.requests).toEqual([
      { url: "https://cdn.example/logo.png", address: "93.184.216.34", headers: { "User-Agent": IMAGE_PROXY_USER_AGENT, Accept: "image/*" } },
    ]);
  });

  it("niente di chi legge verso il mittente: solo User-Agent generico e Accept", async () => {
    const d = deps();
    await fetchRemoteImage("https://cdn.example/a.png", d);
    const headers = d.requests[0]!.headers;
    expect(Object.keys(headers).sort()).toEqual(["Accept", "User-Agent"]);
    expect(IMAGE_PROXY_USER_AGENT.replace("Mozilla/5.0", "")).not.toMatch(/stubwise|\d/i);
  });

  it("un nome che risolve ANCHE a un indirizzo privato è rifiutato, senza richiesta", async () => {
    const d = deps({ resolve: async () => ["93.184.216.34", "10.0.0.5"] });
    expect(await fetchRemoteImage("https://cdn.example/a.png", d)).toEqual({ ok: false, reason: "address" });
    expect(d.requests).toEqual([]);
    expect(await fetchRemoteImage("https://cdn.example/a.png", deps({ resolve: async () => [] }))).toEqual({ ok: false, reason: "address" });
  });

  it("un URL vietato (http, porta, credenziali, IP privato letterale) non risolve né chiede niente", async () => {
    const resolve = vi.fn(async () => ["93.184.216.34"]);
    for (const url of ["http://cdn.example/a.png", "https://cdn.example:8443/a.png", "https://u:p@cdn.example/a.png", "https://0x7f000001/a.png"]) {
      const d = deps({ resolve });
      expect((await fetchRemoteImage(url, d)).ok).toBe(false);
      expect(d.requests).toEqual([]);
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("i redirect si seguono a mano, ricontrollati per intero: un salto verso il metadata è rifiutato", async () => {
    const seen: string[] = [];
    const d = deps({
      request: async (req) => {
        seen.push(req.url.href);
        if (req.url.pathname === "/a.png") return response({ status: 302, headers: { location: "/b.png" } });
        if (req.url.pathname === "/b.png") return response({ status: 301, headers: { location: "https://169.254.169.254/latest" } });
        return response();
      },
    });
    expect(await fetchRemoteImage("https://cdn.example/a.png", d)).toEqual({ ok: false, reason: "address" });
    expect(seen).toEqual(["https://cdn.example/a.png", "https://cdn.example/b.png"]);
  });

  it("un redirect verso un nome che risolve a un privato è rifiutato al suo salto", async () => {
    const d = deps({
      resolve: async (host) => (host === "evil.example" ? ["127.0.0.1"] : ["93.184.216.34"]),
      request: async (req) => (req.url.host === "cdn.example" ? response({ status: 307, headers: { location: "https://evil.example/x.png" } }) : response()),
    });
    expect(await fetchRemoteImage("https://cdn.example/a.png", d)).toEqual({ ok: false, reason: "address" });
  });

  it("al più 3 redirect: il quarto è rifiutato", async () => {
    let n = 0;
    const d = deps({ request: async () => response({ status: 302, headers: { location: `/r${++n}.png` } }) });
    expect(await fetchRemoteImage("https://cdn.example/a.png", d)).toEqual({ ok: false, reason: "redirects" });
    expect(n).toBe(4);
    let m = 0;
    const ok = deps({ request: async () => (++m <= 3 ? response({ status: 302, headers: { location: `/r${m}.png` } }) : response()) });
    expect((await fetchRemoteImage("https://cdn.example/a.png", ok)).ok).toBe(true);
  });

  it("solo 200: un 404 o un 302 senza Location è image_unavailable", async () => {
    expect(await fetchRemoteImage("https://cdn.example/a.png", deps({ request: async () => response({ status: 404 }) }))).toEqual({ ok: false, reason: "status" });
    expect(await fetchRemoteImage("https://cdn.example/a.png", deps({ request: async () => response({ status: 302, headers: {} }) }))).toEqual({ ok: false, reason: "status" });
  });

  it("oltre 5 MB: rifiutato dal Content-Length o a metà flusso", async () => {
    const big = deps({ request: async () => response({ headers: { "content-type": "image/png", "content-length": String(6 * 1024 * 1024) } }) });
    expect(await fetchRemoteImage("https://cdn.example/a.png", big)).toEqual({ ok: false, reason: "too_large" });
    const chunk = Buffer.alloc(1024 * 1024);
    const streamed = deps({ request: async () => response({ chunks: [PNG, chunk, chunk, chunk, chunk, chunk, chunk] }) });
    expect(await fetchRemoteImage("https://cdn.example/a.png", streamed)).toEqual({ ok: false, reason: "too_large" });
  });

  it("il tempo totale: una risposta che non arriva è timeout", async () => {
    const d = deps({ totalMs: 30, request: (req) => new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("aborted")))) });
    expect(await fetchRemoteImage("https://cdn.example/a.png", d)).toEqual({ ok: false, reason: "timeout" });
  });

  it("il tipo lo decidono i byte: HTML dichiarato png, SVG, tipi che non combaciano → not_image", async () => {
    const html = deps({ request: async () => response({ chunks: [Buffer.from("<html><script>")] }) });
    expect(await fetchRemoteImage("https://cdn.example/a.png", html)).toEqual({ ok: false, reason: "not_image" });
    const svg = deps({ request: async () => response({ headers: { "content-type": "image/svg+xml" }, chunks: [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')] }) });
    expect(await fetchRemoteImage("https://cdn.example/a.svg", svg)).toEqual({ ok: false, reason: "not_image" });
    const mismatch = deps({ request: async () => response({ headers: { "content-type": "image/png" }, chunks: [JPEG] }) });
    expect(await fetchRemoteImage("https://cdn.example/a.png", mismatch)).toEqual({ ok: false, reason: "not_image" });
    const text = deps({ request: async () => response({ headers: { "content-type": "text/html" } }) });
    expect(await fetchRemoteImage("https://cdn.example/a.png", text)).toEqual({ ok: false, reason: "not_image" });
    const jpg = deps({ request: async () => response({ headers: { "content-type": "image/jpg" }, chunks: [JPEG] }) });
    expect(await fetchRemoteImage("https://cdn.example/a.jpg", jpg)).toMatchObject({ ok: true, contentType: "image/jpeg" });
  });

  it("un errore di rete è network, mai un'eccezione", async () => {
    const d = deps({ request: async () => { throw new Error("ECONNRESET"); } });
    expect(await fetchRemoteImage("https://cdn.example/a.png", d)).toEqual({ ok: false, reason: "network" });
  });

  it("al più 8 richieste verso l'esterno insieme, per tutta l'istanza", async () => {
    let inFlight = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const d = deps({
      request: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((go) => gates.push(go));
        inFlight--;
        return response();
      },
    });
    const all = Array.from({ length: 9 }, () => fetchRemoteImage("https://cdn.example/a.png", d));
    await new Promise((r) => setTimeout(r, 20));
    expect(peak).toBe(8);
    while (gates.length) {
      gates.shift()!();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await Promise.all(all)).every((r) => r.ok)).toBe(true);
    expect(peak).toBe(8);
  });
});
