// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/nonexistent" }, safeStorage: {} }));

const { handleApiRequest, isAllowedApiPath } = await import("./apiProxy");

function deps(over: Partial<Parameters<typeof handleApiRequest>[1]> = {}) {
  return {
    instanceUrl: () => "https://example.com",
    token: () => "stw_pat_x",
    onUnauthorized: vi.fn(),
    fetch: vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
    ...over,
  };
}

describe("proxy delle richieste API", () => {
  it("rifiuta /webhooks e ../", async () => {
    for (const path of [
      "/webhooks/github",
      "/api/../webhooks",
      "/api/x/%2e%2e/y",
      "//evil.example/api/x",
      "/api//x",
      "https://evil.example/api/x",
      "/api\\x",
      "api/x",
      "/api/x#frag",
    ]) {
      expect(isAllowedApiPath(path), path).toBe(false);
    }
    const d = deps();
    const res = await handleApiRequest({ method: "GET", path: "/webhooks/github" }, d);
    expect(res.status).toBe(400);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("accetta i percorsi /api/ con la query", () => {
    expect(isAllowedApiPath("/api/tasks?families=todo,active&q=a%20b")).toBe(true);
  });

  it("aggiunge il bearer e scarta le intestazioni di autenticazione del renderer", async () => {
    const d = deps();
    const res = await handleApiRequest(
      {
        method: "POST",
        path: "/api/tasks",
        headers: { "content-type": "application/json", authorization: "Bearer other", cookie: "s=1" },
        body: "{}",
      },
      d,
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe(JSON.stringify({ ok: 1 }));
    const [url, init] = vi.mocked(d.fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.com/api/tasks");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer stw_pat_x");
    expect(headers.cookie).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
    expect(init.body).toBe("{}");
  });

  it("sul desktop un 401 invalid_second_factor non cancella il token", async () => {
    const d = deps({
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ code: "invalid_second_factor", message: "x" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ),
    });
    const res = await handleApiRequest({ method: "POST", path: "/api/me/security/reauth", body: "{}" }, d);
    expect(res.status).toBe(401);
    expect(d.onUnauthorized).not.toHaveBeenCalled();
  });

  it("un 401 su /api/auth/me chiude la sessione anche senza code", async () => {
    const d = deps({ fetch: vi.fn(async () => new Response("{}", { status: 401 })) });
    await handleApiRequest({ method: "GET", path: "/api/auth/me" }, d);
    expect(d.onUnauthorized).toHaveBeenCalledWith("stw_pat_x");
  });

  it("un 401 cancella il token", async () => {
    const d = deps({
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ code: "unauthorized", message: "x" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ),
    });
    const res = await handleApiRequest({ method: "GET", path: "/api/tasks" }, d);
    expect(res.status).toBe(401);
    // Il token usato: chi cancella controlla che sia ancora quello corrente.
    expect(d.onUnauthorized).toHaveBeenCalledWith("stw_pat_x");
  });

  it("senza istanza o senza token non esce in rete", async () => {
    const noInstance = deps({ instanceUrl: () => null });
    expect((await handleApiRequest({ method: "GET", path: "/api/x" }, noInstance)).status).toBe(400);
    const noToken = deps({ token: () => null });
    expect((await handleApiRequest({ method: "GET", path: "/api/x" }, noToken)).status).toBe(401);
    expect(noInstance.fetch).not.toHaveBeenCalled();
    expect(noToken.fetch).not.toHaveBeenCalled();
  });

  it("una richiesta malformata dall'IPC è rifiutata", async () => {
    const d = deps();
    for (const bad of [null, "x", { method: "TRACE", path: "/api/x" }, { method: "GET" }]) {
      expect((await handleApiRequest(bad, d)).status).toBe(400);
    }
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("un corpo binario torna come ArrayBuffer", async () => {
    const d = deps({
      fetch: vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          }),
      ),
    });
    const res = await handleApiRequest({ method: "GET", path: "/api/attachments/a/download" }, d);
    expect(res.body).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(res.body as ArrayBuffer)]).toEqual([1, 2, 3]);
  });

  it("un errore di rete diventa 502 network_error", async () => {
    const d = deps({
      fetch: vi.fn(async () => {
        throw new TypeError("offline");
      }),
    });
    const res = await handleApiRequest({ method: "GET", path: "/api/x" }, d);
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body as string)).toMatchObject({ code: "network_error" });
  });
});

describe("«Apri nel web»", () => {
  it("accetta solo un percorso relativo dell'istanza", async () => {
    const { isWebPath } = await import("./apiProxy");
    expect(isWebPath("/tickets/9b1c?tab=plan")).toBe(true);
    expect(isWebPath("/")).toBe(true);
    for (const bad of ["//evil.example", "https://evil.example", "tickets", "/a\\b", "/a\nb", 3]) {
      expect(isWebPath(bad), String(bad)).toBe(false);
    }
  });
  it("il tetto del corpo: 26 MB solo per l'upload di un allegato della Chat, 15 MB altrove", async () => {
    const CH = "7f1c2a1e-0000-4000-8000-0000000000c1";
    const mb = (n: number) => new ArrayBuffer(n * 1024 * 1024);
    const send = async (method: string, path: string, size: number) => {
      const d = deps();
      const res = await handleApiRequest({ method, path, body: mb(size) }, d);
      return { status: res.status, called: (d.fetch as ReturnType<typeof vi.fn>).mock.calls.length };
    };
    // L'upload della Chat: 25 MB passano, 27 no.
    expect(await send("POST", `/api/chat/channels/${CH}/attachments`, 25)).toEqual({ status: 200, called: 1 });
    expect((await send("POST", `/api/chat/channels/${CH}/attachments`, 27)).called).toBe(0);
    // Altrove resta 15 MB: anche gli allegati dei ticket, un altro metodo o un percorso simile.
    for (const [method, path] of [
      ["POST", `/api/tickets/${CH}/attachments`],
      ["PUT", `/api/chat/channels/${CH}/attachments`],
      ["POST", `/api/chat/channels/${CH}/attachments/x`],
      ["POST", `/api/chat/channels/not-a-uuid/attachments`],
      ["POST", "/api/tasks"],
    ] as const) {
      expect((await send(method, path, 16)).called, `${method} ${path}`).toBe(0);
      expect((await send(method, path, 14)).called, `${method} ${path}`).toBe(1);
    }
  });
  it("su un percorso di download il proxy non consegna il Location: l'URL firmato non arriva al renderer", async () => {
    const ID = "7f1c2a1e-0000-4000-8000-0000000000a1";
    const redirectTo = (location: string) =>
      deps({ fetch: vi.fn(async () => new Response(null, { status: 302, headers: { location } })) });
    for (const path of [`/api/chat/attachments/${ID}/download`, `/api/attachments/${ID}/download`]) {
      const res = await handleApiRequest({ method: "GET", path }, redirectTo("https://storage.example.com/x?sig=1"));
      expect(res.status, path).toBe(302);
      expect(res.headers.location, path).toBeUndefined();
    }
    // Altrove il Location resta (non è un URL firmato).
    const other = await handleApiRequest({ method: "GET", path: "/api/tasks" }, redirectTo("/api/tasks/"));
    expect(other.headers.location).toBe("/api/tasks/");
  });
});
