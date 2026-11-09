// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = { path: "", encryption: true };
vi.mock("electron", () => ({
  app: { getPath: () => env.path },
  safeStorage: {
    isEncryptionAvailable: () => env.encryption,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => {
      const s = b.toString();
      if (!s.startsWith("enc:")) throw new Error("bad");
      return s.slice(4);
    },
  },
}));

const session = await import("./session");

beforeEach(() => {
  env.path = mkdtempSync(join(tmpdir(), "stubwise-session-"));
  env.encryption = true;
  session.clearToken();
});
afterEach(() => rmSync(env.path, { recursive: true, force: true }));

const file = () => join(env.path, "session.bin");

describe("token della sessione", () => {
  it("si salva cifrato e si rilegge", () => {
    session.saveToken("stw_pat_abc", "pat-1");
    expect(existsSync(file())).toBe(true);
    session.forgetMemory();
    expect(session.readToken()).toBe("stw_pat_abc");
    expect(session.readPatId()).toBe("pat-1");
  });

  it("senza cifratura disponibile non scrive su disco", () => {
    env.encryption = false;
    session.saveToken("stw_pat_abc", "pat-1");
    expect(existsSync(file())).toBe(false);
    // Vale per questa esecuzione: al prossimo avvio si rifà il login.
    expect(session.readToken()).toBe("stw_pat_abc");
    session.forgetMemory();
    expect(session.readToken()).toBeNull();
  });

  it("clearToken cancella file e memoria", () => {
    session.saveToken("stw_pat_abc", "pat-1");
    session.clearToken();
    expect(existsSync(file())).toBe(false);
    expect(session.readToken()).toBeNull();
  });
});

describe("login", () => {
  const ok = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("chiama mobile-login col nome del device, salva il token e non lo restituisce", async () => {
    const fetchImpl = vi.fn(async () =>
      ok({ token: "stw_pat_x", patId: "pat-9", user: { id: "u1", email: "a@b.c" } }),
    );
    const result = await session.login(
      { email: "a@b.c", password: "pw", code: "123456" },
      { instanceUrl: "https://example.com", hostname: "mac", fetch: fetchImpl },
    );
    expect(result).toEqual({ ok: true, user: { id: "u1", email: "a@b.c" } });
    expect(JSON.stringify(result)).not.toContain("stw_pat_x");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.com/api/auth/mobile-login");
    expect(JSON.parse(init.body as string)).toEqual({
      email: "a@b.c",
      password: "pw",
      code: "123456",
      deviceName: "Desktop · mac",
    });
    expect(session.readToken()).toBe("stw_pat_x");
  });

  it("il secondo fattore richiesto torna come codice, senza salvare niente", async () => {
    const fetchImpl = vi.fn(async () => ok({ code: "second_factor_required", message: "x" }, 401));
    const result = await session.login(
      { email: "a@b.c", password: "pw" },
      { instanceUrl: "https://example.com", hostname: "mac", fetch: fetchImpl },
    );
    expect(result).toEqual({ ok: false, code: "second_factor_required" });
    expect(session.readToken()).toBeNull();
  });

  it("senza istanza o con un input non valido non chiama la rete", async () => {
    const fetchImpl = vi.fn();
    expect(
      await session.login(
        { email: "a@b.c", password: "pw" },
        { instanceUrl: null, hostname: "mac", fetch: fetchImpl },
      ),
    ).toEqual({ ok: false, code: "no_instance" });
    expect(
      await session.login(
        { email: 3, password: "" },
        { instanceUrl: "https://example.com", hostname: "mac", fetch: fetchImpl },
      ),
    ).toEqual({ ok: false, code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("un errore di rete torna come network_error", async () => {
    const result = await session.login(
      { email: "a@b.c", password: "pw" },
      {
        instanceUrl: "https://example.com",
        hostname: "mac",
        fetch: async () => {
          throw new TypeError("offline");
        },
      },
    );
    expect(result).toEqual({ ok: false, code: "network_error" });
  });
});

describe("logout", () => {
  it("revoca il PAT col bearer e cancella il token anche se la revoca fallisce", async () => {
    session.saveToken("stw_pat_x", "pat-9");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    await session.logout({ instanceUrl: "https://example.com", fetch: fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.com/api/pats/pat-9");
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer stw_pat_x");
    expect(session.readToken()).toBeNull();
  });
});
