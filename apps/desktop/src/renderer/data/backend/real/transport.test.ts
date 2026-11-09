import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppClient, ipcFetch } from "./transport";

type Req = Parameters<NonNullable<NonNullable<Window["stubwise"]>["api"]>["request"]>[0];

function withBridge(reply: (req: Req) => Promise<{ status: number; headers: Record<string, string>; body: string | ArrayBuffer }>) {
  const request = vi.fn(reply);
  window.stubwise = { platform: "darwin", api: { request } };
  return request;
}

afterEach(() => {
  delete window.stubwise;
});

describe("ipcFetch (desktop)", () => {
  it("manda metodo, percorso, intestazioni e corpo al main, e costruisce la Response", async () => {
    const request = withBridge(async () => ({
      status: 201,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "t1" }),
    }));
    const res = await ipcFetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/tasks",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "t1" });
  });

  it("un corpo FormData (allegati) arriva come byte col suo content-type", async () => {
    const request = withBridge(async () => ({ status: 200, headers: {}, body: "{}" }));
    const form = new FormData();
    form.append("file", new Blob(["ciao"], { type: "text/plain" }), "a.txt");
    await ipcFetch("/api/tickets/t1/attachments", { method: "POST", body: form });
    const sent = request.mock.calls[0]![0];
    expect(sent.body).toBeInstanceOf(ArrayBuffer);
    expect(sent.headers!["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
  });

  it("un 204 non ha corpo", async () => {
    withBridge(async () => ({ status: 204, headers: {}, body: "" }));
    const res = await ipcFetch("/api/tasks/t1/follow", { method: "PUT" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("rifiuta un metodo che il main non accetta", async () => {
    withBridge(async () => ({ status: 200, headers: {}, body: "" }));
    await expect(ipcFetch("/api/x", { method: "HEAD" })).rejects.toThrow();
  });
});

describe("createAppClient", () => {
  it("sul desktop passa dal ponte del preload, mai dalla rete", async () => {
    const request = withBridge(async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify([]),
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createAppClient();
    await client.request("GET", "/api/inbox");
    expect(request).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("nel browser usa fetch con il cookie (credentials: include) e nessun bearer", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    const client = createAppClient();
    await client.request("GET", "/api/inbox");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/inbox");
    expect(init?.credentials).toBe("include");
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    fetchSpy.mockRestore();
  });
});
