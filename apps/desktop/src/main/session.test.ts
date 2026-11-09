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

describe("un login nuovo sostituisce il token", () => {
  it("salva il token nuovo e revoca il PAT di prima (best-effort, col suo bearer)", async () => {
    session.saveToken("stw_pat_old", "pat-old");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await session.replaceToken("stw_pat_new", "pat-new", { instanceUrl: "https://example.com", fetch: fetchImpl });
    expect(session.readToken()).toBe("stw_pat_new");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.com/api/pats/pat-old");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer stw_pat_old");
  });

  it("una revoca che fallisce non tocca il token nuovo", async () => {
    session.saveToken("stw_pat_old", "pat-old");
    await session.replaceToken("stw_pat_new", "pat-new", {
      instanceUrl: "https://example.com",
      fetch: async () => {
        throw new TypeError("offline");
      },
    });
    expect(session.readToken()).toBe("stw_pat_new");
  });

  it("senza un token di prima non revoca niente", async () => {
    const fetchImpl = vi.fn();
    await session.replaceToken("stw_pat_new", "pat-new", { instanceUrl: "https://example.com", fetch: fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
