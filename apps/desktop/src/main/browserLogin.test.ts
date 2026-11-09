// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createBrowserLogin, deviceNameFrom, type BrowserLoginDeps, type SessionChange } from "./browserLogin";

function setup(over: Partial<BrowserLoginDeps> = {}) {
  const opened: string[] = [];
  const saved: [string, string | null][] = [];
  const changes: SessionChange[] = [];
  let clock = 1_000_000;
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify({ token: "stw_pat_desk", patId: "pat-1", user: { id: "u1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const deps: BrowserLoginDeps = {
    instanceUrl: () => "https://stubwise.example",
    openExternal: (url) => {
      opened.push(url);
    },
    hostname: () => "MacBook-di-Ale.local",
    fetch: fetchImpl,
    now: () => clock,
    saveToken: (token, patId) => {
      saved.push([token, patId]);
    },
    notify: (change) => {
      changes.push(change);
    },
    ...over,
  };
  const login = createBrowserLogin(deps);
  return { login, opened, saved, changes, fetchImpl, tick: (ms: number) => (clock += ms) };
}

/** I parametri della pagina aperta nel browser (dopo `#/desktop-login?`). */
function openedParams(url: string): URLSearchParams {
  return new URLSearchParams(url.slice(url.indexOf("?") + 1));
}

describe("startBrowserLogin", () => {
  it("apre /app/#/desktop-login con challenge, state e nome del dispositivo; mai il verifier", async () => {
    const { login, opened } = setup();
    const started = await login.start();
    expect(started.ok).toBe(true);
    expect(opened).toHaveLength(1);
    const url = opened[0]!;
    expect(url.startsWith("https://stubwise.example/app/#/desktop-login?")).toBe(true);
    const params = openedParams(url);
    expect(params.get("state")).toBe(started.ok ? started.state : "");
    expect(params.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get("device")).toBe("MacBook-di-Ale");
    expect([...params.keys()].sort()).toEqual(["challenge", "device", "state"]);
  });

  it("senza istanza non apre niente", async () => {
    const { login, opened } = setup({ instanceUrl: () => null });
    expect(await login.start()).toEqual({ ok: false, code: "no_instance" });
    expect(opened).toEqual([]);
  });
});

describe("handleAuthUrl", () => {
  it("il codice giusto con lo state giusto: scambio con il verifier del challenge, token salvato, renderer avvisato", async () => {
    const { login, opened, saved, changes, fetchImpl } = setup();
    const started = await login.start();
    if (!started.ok) throw new Error("start");
    const challenge = openedParams(opened[0]!).get("challenge")!;
    const result = await login.handleAuthUrl(`stubwise://auth?code=CODICE&state=${started.state}`);
    expect(result).toEqual({ ok: true, user: { id: "u1" } });
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://stubwise.example/api/auth/desktop-exchange");
    const body = JSON.parse(init.body as string) as { code: string; codeVerifier: string; deviceName: string };
    expect(body.code).toBe("CODICE");
    expect(body.deviceName).toBe("MacBook-di-Ale");
    expect(createHash("sha256").update(body.codeVerifier).digest("base64url")).toBe(challenge);
    expect(saved).toEqual([["stw_pat_desk", "pat-1"]]);
    expect(changes).toEqual([{ signedIn: true, user: { id: "u1" } }]);
    // Il renderer non vede mai il token.
    expect(JSON.stringify(changes)).not.toContain("stw_pat_desk");
    expect(JSON.stringify(result)).not.toContain("stw_pat_desk");
  });

  it("state sbagliato: ignorato", async () => {
    const { login, fetchImpl, saved } = setup();
    await login.start();
    expect(await login.handleAuthUrl("stubwise://auth?code=C&state=altro")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it("un secondo URL con lo stesso state dopo il successo: ignorato", async () => {
    const { login, fetchImpl } = setup();
    const started = await login.start();
    if (!started.ok) throw new Error("start");
    await login.handleAuthUrl(`stubwise://auth?code=C&state=${started.state}`);
    expect(await login.handleAuthUrl(`stubwise://auth?code=C2&state=${started.state}`)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("host diverso da auth, schema diverso o codice assente: ignorato", async () => {
    const { login, fetchImpl } = setup();
    const started = await login.start();
    if (!started.ok) throw new Error("start");
    const s = started.state;
    expect(await login.handleAuthUrl(`stubwise://altro?code=C&state=${s}`)).toBeNull();
    expect(await login.handleAuthUrl(`https://auth?code=C&state=${s}`)).toBeNull();
    expect(await login.handleAuthUrl(`stubwise://auth?state=${s}`)).toBeNull();
    expect(await login.handleAuthUrl("non è un url")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    // La richiesta pendente è ancora lì: l'URL giusto passa.
    expect(await login.handleAuthUrl(`stubwise://auth?code=C&state=${s}`)).toMatchObject({ ok: true });
  });

  it("una richiesta più vecchia di 5 minuti non vale più (e lo si dice: «expired»)", async () => {
    const { login, fetchImpl, tick } = setup();
    const started = await login.start();
    if (!started.ok) throw new Error("start");
    tick(5 * 60 * 1000 + 1);
    expect(await login.handleAuthUrl(`stubwise://auth?code=C&state=${started.state}`)).toEqual({
      ok: false,
      code: "expired",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cancel: l'URL che arriva dopo è ignorato", async () => {
    const { login, fetchImpl } = setup();
    const started = await login.start();
    if (!started.ok) throw new Error("start");
    login.cancel();
    expect(await login.handleAuthUrl(`stubwise://auth?code=C&state=${started.state}`)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("una sola richiesta pendente: un nuovo start sostituisce la precedente", async () => {
    const { login } = setup();
    const first = await login.start();
    const second = await login.start();
    if (!first.ok || !second.ok) throw new Error("start");
    expect(await login.handleAuthUrl(`stubwise://auth?code=C&state=${first.state}`)).toEqual({
      ok: false,
      code: "expired",
    });
    expect(await login.handleAuthUrl(`stubwise://auth?code=C&state=${second.state}`)).toMatchObject({ ok: true });
  });

  it("errore di scambio: il renderer riceve l'errore, nessun token salvato", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ code: "invalid_grant", message: "x" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    const { login, saved, changes } = setup({ fetch: fetchImpl });
    const started = await login.start();
    if (!started.ok) throw new Error("start");
    expect(await login.handleAuthUrl(`stubwise://auth?code=C&state=${started.state}`)).toEqual({
      ok: false,
      code: "invalid_grant",
    });
    expect(saved).toEqual([]);
    expect(changes).toEqual([{ signedIn: false, error: "invalid_grant" }]);
  });

  it("errore di rete: network_error al renderer", async () => {
    const { login, changes } = setup({
      fetch: async () => {
        throw new TypeError("offline");
      },
    });
    const started = await login.start();
    if (!started.ok) throw new Error("start");
    expect(await login.handleAuthUrl(`stubwise://auth?code=C&state=${started.state}`)).toEqual({
      ok: false,
      code: "network_error",
    });
    expect(changes).toEqual([{ signedIn: false, error: "network_error" }]);
  });
});

describe("deviceNameFrom", () => {
  it("toglie .local, i caratteri di controllo e taglia a 60", () => {
    expect(deviceNameFrom("MacBook-di-Ale.local")).toBe("MacBook-di-Ale");
    expect(deviceNameFrom("a\nb‮c")).toBe("abc");
    expect(deviceNameFrom("x".repeat(80))).toHaveLength(60);
    expect(deviceNameFrom("")).toBe("Mac");
  });
});

describe("richieste scadute, sostituite e legate all'istanza", () => {
  const authUrl = (state: string) => `stubwise://auth?code=CODICE&state=${state}`;

  it("lo state di una richiesta scaduta avvisa «expired» e non scambia", async () => {
    const { login, changes, fetchImpl, tick } = setup();
    const started = await login.start();
    if (!started.ok) throw new Error("start");
    tick(6 * 60 * 1000);
    expect(await login.handleAuthUrl(authUrl(started.state))).toEqual({ ok: false, code: "expired" });
    expect(changes).toEqual([{ signedIn: false, error: "expired" }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lo state di una richiesta appena sostituita avvisa «expired»", async () => {
    const { login, changes, fetchImpl } = setup();
    const first = await login.start();
    await login.start();
    if (!first.ok) throw new Error("start");
    expect(await login.handleAuthUrl(authUrl(first.state))).toEqual({ ok: false, code: "expired" });
    expect(changes).toEqual([{ signedIn: false, error: "expired" }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uno state mai visto resta ignorato, senza avvisi", async () => {
    const { login, changes } = setup();
    await login.start();
    expect(await login.handleAuthUrl(authUrl("sconosciuto"))).toBeNull();
    expect(changes).toEqual([]);
  });

  it("lo scambio va all'istanza di start(), anche se nel frattempo è cambiata", async () => {
    let instance = "https://a.example";
    const { login, fetchImpl } = setup({ instanceUrl: () => instance });
    const started = await login.start();
    if (!started.ok) throw new Error("start");
    instance = "https://b.example";
    await login.handleAuthUrl(authUrl(started.state));
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://a.example/api/auth/desktop-exchange");
  });
});
