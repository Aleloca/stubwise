// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/nonexistent" }, safeStorage: {} }));

const { createPendingDownloads, downloadDecision, isAllowedDownloadLocation, isAllowedDownloadPath, resolveDownload, safeDownloadName } =
  await import("./apiDownload");

// Il download di un allegato dal desktop (area 4, fetta 4; voce Trasversali
// del registro per i ticket): il main chiede il download COL bearer, pretende
// un 302 e consegna l'URL firmato al download di Electron, che lo chiede
// SENZA intestazioni. Né il token né l'URL firmato passano dal renderer.

const ID = "7f1c2a1e-0000-4000-8000-0000000000a1";
const SIGNED = "https://storage.example.com/bucket/chat/x?X-Amz-Signature=abc";

const redirect = (location: string | null, status = 302) =>
  new Response(null, { status, headers: location ? { location } : {} });

function deps(over: Partial<Parameters<typeof resolveDownload>[1]> = {}) {
  return {
    instanceUrl: () => "https://stubwise.example.com",
    token: () => "stw_pat_x",
    onUnauthorized: vi.fn(),
    fetch: vi.fn(async () => redirect(SIGNED)),
    ...over,
  };
}

describe("i percorsi che si scaricano", () => {
  it("solo il download di un allegato della Chat o di un ticket, con un uuid", () => {
    expect(isAllowedDownloadPath(`/api/chat/attachments/${ID}/download`)).toBe(true);
    expect(isAllowedDownloadPath(`/api/attachments/${ID}/download`)).toBe(true);
    // Area 5, fetta 2: il download di un file del Drive (anche l'«anteprima» sul desktop); la rotta `preview` no.
    expect(isAllowedDownloadPath(`/api/drive/files/${ID}/download`)).toBe(true);
    expect(isAllowedDownloadPath(`/api/drive/files/${ID}/preview`)).toBe(false);
    expect(isAllowedDownloadPath(`/api/drive/files/not-a-uuid/download`)).toBe(false);
    for (const path of [
      `/api/chat/attachments/${ID}`,
      `/api/chat/attachments/not-a-uuid/download`,
      `/api/chat/attachments/${ID}/download?x=1`,
      `/api/chat/attachments/${ID}/download/`,
      `/api/tasks`,
      `https://evil.example/api/attachments/${ID}/download`,
      `/api/attachments/${ID}/../download`,
      42,
    ]) {
      expect(isAllowedDownloadPath(path), String(path)).toBe(false);
    }
  });
});

describe("dove porta il 302", () => {
  it("https sempre; http solo se l'istanza è http; mai un altro schema", () => {
    expect(isAllowedDownloadLocation(SIGNED, "https://stubwise.example.com")).toBe(true);
    expect(isAllowedDownloadLocation("http://minio.local/x", "https://stubwise.example.com")).toBe(false);
    expect(isAllowedDownloadLocation("http://localhost:9000/x", "http://localhost:3000")).toBe(true);
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "ftp://x/y", "data:text/plain,hi", "not a url"]) {
      expect(isAllowedDownloadLocation(bad, "http://localhost:3000"), bad).toBe(false);
    }
  });
});

describe("resolveDownload", () => {
  it("chiede col bearer, senza seguire il reindirizzamento, e restituisce l'URL firmato", async () => {
    const d = deps();
    expect(await resolveDownload({ path: `/api/chat/attachments/${ID}/download` }, d)).toEqual({ ok: true, url: SIGNED });
    const [url, init] = (d.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(`https://stubwise.example.com/api/chat/attachments/${ID}/download`);
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer stw_pat_x");
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("un Location relativo si legge sull'istanza", async () => {
    const d = deps({ fetch: vi.fn(async () => redirect("/files/x?sig=1")) });
    expect(await resolveDownload({ path: `/api/attachments/${ID}/download` }, d)).toEqual({
      ok: true,
      url: "https://stubwise.example.com/files/x?sig=1",
    });
  });

  it("rifiuta: un percorso fuori elenco, nessuna istanza o token, niente 302, un Location vietato", async () => {
    const path = `/api/chat/attachments/${ID}/download`;
    expect(await resolveDownload({ path: "/api/tasks" }, deps())).toEqual({ ok: false, reason: "invalid" });
    expect(await resolveDownload({ path }, deps({ instanceUrl: () => null }))).toEqual({ ok: false, reason: "invalid" });
    expect(await resolveDownload({ path }, deps({ token: () => null }))).toEqual({ ok: false, reason: "unauthenticated" });
    const ok200 = deps({ fetch: vi.fn(async () => new Response("bytes", { status: 200 })) });
    expect(await resolveDownload({ path }, ok200)).toEqual({ ok: false, reason: "failed" });
    expect(await resolveDownload({ path }, deps({ fetch: vi.fn(async () => redirect(null)) }))).toEqual({ ok: false, reason: "failed" });
    expect(await resolveDownload({ path }, deps({ fetch: vi.fn(async () => redirect("file:///etc/passwd")) }))).toEqual({
      ok: false,
      reason: "failed",
    });
    const gone = deps({ fetch: vi.fn(async () => new Response(JSON.stringify({ code: "not_found" }), { status: 404 })) });
    expect(await resolveDownload({ path }, gone)).toEqual({ ok: false, reason: "not_found" });
    const offline = deps({ fetch: vi.fn(async () => Promise.reject(new Error("offline"))) });
    expect(await resolveDownload({ path }, offline)).toEqual({ ok: false, reason: "failed" });
  });

  it("solo un 302: un altro reindirizzamento non si segue", async () => {
    const path = `/api/chat/attachments/${ID}/download`;
    for (const status of [301, 303, 307, 308]) {
      expect(await resolveDownload({ path }, deps({ fetch: vi.fn(async () => redirect(SIGNED, status)) })), String(status)).toEqual({
        ok: false,
        reason: "failed",
      });
    }
  });

  it("un 401 di sessione chiude la sessione, col token con cui è partito", async () => {
    const d = deps({
      fetch: vi.fn(async () => new Response(JSON.stringify({ code: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } })),
    });
    expect(await resolveDownload({ path: `/api/attachments/${ID}/download` }, d)).toEqual({ ok: false, reason: "unauthenticated" });
    expect(d.onUnauthorized).toHaveBeenCalledWith("stw_pat_x");
  });
});

describe("il nome del file", () => {
  it("solo il nome, mai un percorso; niente caratteri di controllo; un ripiego se vuoto", () => {
    expect(safeDownloadName("spec.pdf")).toBe("spec.pdf");
    expect(safeDownloadName("../../.ssh/authorized_keys")).toBe("authorized_keys");
    expect(safeDownloadName("C:\\Users\\x\\evil.exe")).toBe("evil.exe");
    expect(safeDownloadName("a\u0000b\nc.txt")).toBe("abc.txt");
    expect(safeDownloadName("..")).toBe("download");
    expect(safeDownloadName("")).toBe("download");
  });
});

describe("chi passa da will-download", () => {
  const pending = (url: string) => url === SIGNED;
  it("i blob: e i data: della finestra dell'app passano (codici di backup del 2FA, guida SDK), sempre col «Salva»", () => {
    expect(downloadDecision("blob:file:///6f1c-4e2a", pending, true)).toBe("local");
    expect(downloadDecision("data:text/plain;charset=utf-8,codes", pending, true)).toBe("local");
  });
  it("un download chiesto con api:download passa; un URL estraneo, o un blob da fuori l'app, no", () => {
    expect(downloadDecision(SIGNED, pending, true)).toBe("requested");
    expect(downloadDecision("https://evil.example/payload.dmg", pending, true)).toBe("reject");
    expect(downloadDecision("blob:https://evil.example/x", pending, false)).toBe("reject");
    expect(downloadDecision("file:///etc/passwd", pending, true)).toBe("reject");
  });
});

describe("i download in attesa", () => {
  it("due api:download con lo stesso URL firmato: ognuno ha il suo esito, in ordine", () => {
    const pending = createPendingDownloads<string>();
    pending.add(SIGNED, "first");
    pending.add(SIGNED, "second");
    expect(pending.has(SIGNED)).toBe(true);
    expect(pending.take(SIGNED)).toBe("first");
    expect(pending.take(SIGNED)).toBe("second");
    expect(pending.has(SIGNED)).toBe(false);
    expect(pending.take(SIGNED)).toBeUndefined();
  });

  it("il ritiro (il timer) toglie solo quello di chi lo chiede, e dice se c'era ancora", () => {
    const pending = createPendingDownloads<string>();
    const dropFirst = pending.add(SIGNED, "first");
    pending.add(SIGNED, "second");
    expect(dropFirst()).toBe(true);
    expect(dropFirst()).toBe(false);
    expect(pending.take(SIGNED)).toBe("second");
  });

  it("l'URL si confronta normalizzato: caratteri speciali nella query, scritti in due modi", () => {
    const pending = createPendingDownloads<string>();
    pending.add("https://storage.example.com/k?X-Amz-Signature=a b&name=città", "one");
    expect(pending.has("https://storage.example.com/k?X-Amz-Signature=a%20b&name=citt%C3%A0")).toBe(true);
    expect(pending.take("https://storage.example.com/k?X-Amz-Signature=a%20b&name=citt%C3%A0")).toBe("one");
  });
});
