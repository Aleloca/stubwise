import { describe, expect, it, vi } from "vitest";

import { runSetup, type SetupDeps } from "./setup.js";

function makeDeps(fetchImpl: typeof fetch): SetupDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    fetch: fetchImpl,
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => undefined),
    chmod: vi.fn(async () => {}),
    log: (m: string) => logs.push(m),
    configPath: "/fake/home/.config/stubwise/config.json",
    logs,
  };
}

const ok = () =>
  new Response(JSON.stringify({ user: { id: "u1", email: "a@b.it", role: "member" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("runSetup", () => {
  it("token valido: scrive il file 0600 e restituisce 0", async () => {
    const deps = makeDeps(vi.fn(async () => ok()) as unknown as typeof fetch);
    const code = await runSetup(["--url", "https://s.example.com/", "--token", "stw_pat_x"], deps);
    expect(code).toBe(0);
    expect(deps.writeFile).toHaveBeenCalledTimes(1);
    const [path, content, opts] = vi.mocked(deps.writeFile).mock.calls[0]!;
    expect(path).toBe("/fake/home/.config/stubwise/config.json");
    expect(JSON.parse(content as string)).toEqual({
      url: "https://s.example.com",
      token: "stw_pat_x",
    });
    expect(opts).toMatchObject({ mode: 0o600 });
    expect(deps.chmod).toHaveBeenCalledWith(path, 0o600);
    expect(deps.logs.join("\n")).toContain("Configurato come a@b.it su https://s.example.com");
    expect(deps.logs.join("\n")).not.toContain("stw_pat_x");
  });

  it("401: restituisce 1 e non scrive nulla", async () => {
    const deps = makeDeps(
      vi.fn(
        async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      ) as unknown as typeof fetch,
    );
    const code = await runSetup(["--url", "https://s.example.com", "--token", "bad"], deps);
    expect(code).toBe(1);
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.logs.join("\n")).not.toContain("bad");
  });

  it("URL irraggiungibile: 1, nulla scritto", async () => {
    const deps = makeDeps(
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    );
    expect(await runSetup(["--url", "http://localhost:1", "--token", "x"], deps)).toBe(1);
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it("URL senza schema: errore, nessuna chiamata di rete", async () => {
    const f = vi.fn();
    const deps = makeDeps(f as unknown as typeof fetch);
    expect(await runSetup(["--url", "s.example.com", "--token", "x"], deps)).toBe(1);
    expect(f).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it("argomenti mancanti: 1", async () => {
    const deps = makeDeps(vi.fn() as unknown as typeof fetch);
    expect(await runSetup(["--url", "https://s.example.com"], deps)).toBe(1);
  });
});
