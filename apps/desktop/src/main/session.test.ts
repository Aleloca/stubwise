// @vitest-environment node
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const instance = await import("./instance");
const I = "https://example.com";

beforeEach(() => {
  env.path = mkdtempSync(join(tmpdir(), "stubwise-session-"));
  env.encryption = true;
  session.clearToken();
  instance.writeInstanceUrl(I);
});
afterEach(() => rmSync(env.path, { recursive: true, force: true }));

const file = () => join(env.path, "session.bin");

describe("token della sessione", () => {
  it("si salva cifrato e si rilegge", () => {
    session.saveToken("stw_pat_abc", "pat-1", I);
    expect(existsSync(file())).toBe(true);
    session.forgetMemory();
    expect(session.readToken()).toBe("stw_pat_abc");
    expect(session.readPatId()).toBe("pat-1");
  });

  it("senza cifratura disponibile non scrive su disco", () => {
    env.encryption = false;
    session.saveToken("stw_pat_abc", "pat-1", I);
    expect(existsSync(file())).toBe(false);
    // Vale per questa esecuzione: al prossimo avvio si rifà il login.
    expect(session.readToken()).toBe("stw_pat_abc");
    session.forgetMemory();
    expect(session.readToken()).toBeNull();
  });

  it("clearToken cancella file e memoria", () => {
    session.saveToken("stw_pat_abc", "pat-1", I);
    session.clearToken();
    expect(existsSync(file())).toBe(false);
    expect(session.readToken()).toBeNull();
  });
});

describe("logout", () => {
  it("revoca il PAT col bearer e cancella il token anche se la revoca fallisce", async () => {
    session.saveToken("stw_pat_x", "pat-9", I);
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
    session.saveToken("stw_pat_old", "pat-old", I);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await session.replaceToken("stw_pat_new", "pat-new", {
      instanceUrl: "https://example.com",
      fetch: fetchImpl,
    });
    expect(session.readToken()).toBe("stw_pat_new");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.com/api/pats/pat-old");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer stw_pat_old");
  });

  it("una revoca che fallisce non tocca il token nuovo", async () => {
    session.saveToken("stw_pat_old", "pat-old", I);
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
    await session.replaceToken("stw_pat_new", "pat-new", {
      instanceUrl: "https://example.com",
      fetch: fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// Seconda revisione di sicurezza della cassaforte, I3: `instance.json` non è
// un segreto, e chi lo riscrive mandava il PAT a un host suo. Il token è
// legato all'istanza dello scambio, dentro il blob cifrato: con un'istanza
// diversa non esce, la sessione si chiude e il main lo sa (`sessionChanged`).
describe("il token è legato alla sua istanza (I3)", () => {
  it("un instance.json riscritto: niente token, sessione chiusa, avviso una volta", () => {
    const changed = vi.fn();
    session.onSessionMismatch(changed);
    session.saveToken("stw_pat_abc", "pat-1", I);
    session.forgetMemory();
    instance.writeInstanceUrl("https://attacker.example");
    expect(session.readToken()).toBeNull();
    expect(session.readPatId()).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
    // Anche tornando all'istanza giusta, il token non c'è più.
    instance.writeInstanceUrl(I);
    expect(session.readToken()).toBeNull();
    expect(existsSync(file())).toBe(false);
  });

  it("anche la copia in memoria (senza Keychain) è legata all'istanza", () => {
    env.encryption = false;
    session.saveToken("stw_pat_abc", "pat-1", I);
    instance.writeInstanceUrl("https://attacker.example");
    expect(session.readToken()).toBeNull();
  });

  it("una sessione salvata prima, senza istanza, non vale: si rifà il login", () => {
    writeFileSync(
      file(),
      Buffer.from(`enc:${JSON.stringify({ token: "stw_pat_old", patId: "p" })}`),
    );
    expect(session.readToken()).toBeNull();
  });

  it("il login salva l'istanza dello SCAMBIO; il PAT di prima si revoca sulla SUA istanza", async () => {
    session.saveToken("stw_pat_old", "pat-old", "https://old.example");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await session.replaceToken("stw_pat_new", "pat-new", { instanceUrl: I, fetch: fetchImpl });
    expect(session.readToken()).toBe("stw_pat_new");
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://old.example/api/pats/pat-old");
  });
});
