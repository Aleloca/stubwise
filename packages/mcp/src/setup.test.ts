import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { claudeSettingsPath, runSetup, type SetupDeps } from "./setup.js";

const SETTINGS = "/fake/home/.claude/settings.json";

function enoent(): Error {
  return Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
}

/**
 * `settings`: il contenuto di `settings.json` di Claude Code, o `null` se il
 * file non esiste. Di default non esiste, così i test sul token non lo toccano.
 */
function makeDeps(
  fetchImpl: typeof fetch,
  settings: string | null = null,
): SetupDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    fetch: fetchImpl,
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async (path: string) => {
      if (path === SETTINGS && settings !== null) return settings;
      throw enoent();
    }),
    mkdir: vi.fn(async () => undefined),
    chmod: vi.fn(async () => {}),
    log: (m: string) => logs.push(m),
    configPath: "/fake/home/.config/stubwise/config.json",
    claudeSettingsPath: SETTINGS,
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

  it("toglie gli spazi copiati insieme a url e token", async () => {
    const fetchMock = vi.fn(async () => ok());
    const deps = makeDeps(fetchMock as unknown as typeof fetch);
    const code = await runSetup(
      ["--url", "  https://s.example.com/ \n", "--token=\tstw_pat_x  "],
      deps,
    );
    expect(code).toBe(0);
    const [, content] = vi.mocked(deps.writeFile).mock.calls[0]!;
    expect(JSON.parse(content as string)).toEqual({
      url: "https://s.example.com",
      token: "stw_pat_x",
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.stringify(init.headers)).toContain('Bearer stw_pat_x"');
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

/** `settings.json` come lo scrive `claude plugin marketplace add … --sparse` (CLI 2.1.304). */
const SETTINGS_WITH_MARKETPLACE = `${JSON.stringify(
  {
    model: "opus",
    extraKnownMarketplaces: {
      stubwise: {
        source: {
          source: "github",
          repo: "Aleloca/stubwise",
          sparsePaths: [".claude-plugin", "plugins"],
        },
      },
      altro: { source: { source: "github", repo: "x/y" } },
    },
    enabledPlugins: { "stubwise@stubwise": true },
  },
  null,
  2,
)}\n`;

const ARGS = ["--url", "https://s.example.com", "--token", "stw_pat_x"];

function settingsWrites(deps: SetupDeps): unknown[][] {
  return vi.mocked(deps.writeFile).mock.calls.filter(([path]) => path === SETTINGS);
}

describe("runSetup — aggiornamento automatico del plugin", () => {
  it("voce stubwise presente: imposta autoUpdate e lascia intatto il resto", async () => {
    const deps = makeDeps(
      vi.fn(async () => ok()) as unknown as typeof fetch,
      SETTINGS_WITH_MARKETPLACE,
    );

    expect(await runSetup(ARGS, deps)).toBe(0);

    const writes = settingsWrites(deps);
    expect(writes).toHaveLength(1);
    const written = writes[0]![1] as string;
    const expected = JSON.parse(SETTINGS_WITH_MARKETPLACE);
    expected.extraKnownMarketplaces.stubwise.autoUpdate = true;
    expect(JSON.parse(written)).toEqual(expected);
    // Stesso formato: due spazi e a capo finale.
    expect(written).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(deps.logs.join("\n")).toContain("Aggiornamenti automatici del plugin accesi");
  });

  it("autoUpdate già acceso: non riscrive il file", async () => {
    const already = JSON.parse(SETTINGS_WITH_MARKETPLACE);
    already.extraKnownMarketplaces.stubwise.autoUpdate = true;
    const deps = makeDeps(
      vi.fn(async () => ok()) as unknown as typeof fetch,
      `${JSON.stringify(already, null, 2)}\n`,
    );

    expect(await runSetup(ARGS, deps)).toBe(0);
    expect(settingsWrites(deps)).toHaveLength(0);
    expect(deps.logs.join("\n")).toContain("Aggiornamenti automatici del plugin accesi");
  });

  it("voce stubwise assente: non la crea, file intatto, spiega come accenderli a mano", async () => {
    const without = `${JSON.stringify({ extraKnownMarketplaces: { altro: {} } }, null, 2)}\n`;
    const deps = makeDeps(vi.fn(async () => ok()) as unknown as typeof fetch, without);

    expect(await runSetup(ARGS, deps)).toBe(0);
    expect(settingsWrites(deps)).toHaveLength(0);
    expect(deps.logs.join("\n")).toContain(
      "/plugin → Marketplaces → stubwise → Enable auto-update",
    );
  });

  it("settings.json assente: non lo crea, spiega come accenderli a mano", async () => {
    const deps = makeDeps(vi.fn(async () => ok()) as unknown as typeof fetch, null);

    expect(await runSetup(ARGS, deps)).toBe(0);
    expect(settingsWrites(deps)).toHaveLength(0);
    expect(deps.logs.join("\n")).toContain(
      "/plugin → Marketplaces → stubwise → Enable auto-update",
    );
  });

  it("settings.json non è JSON valido: non lo tocca, avvisa, esce 0", async () => {
    const deps = makeDeps(vi.fn(async () => ok()) as unknown as typeof fetch, "{ rotto");

    expect(await runSetup(ARGS, deps)).toBe(0);
    expect(settingsWrites(deps)).toHaveLength(0);
    const out = deps.logs.join("\n");
    expect(out).toContain(SETTINGS);
    expect(out).toContain("/plugin → Marketplaces → stubwise → Enable auto-update");
  });

  it("scrittura di settings.json fallita: avvisa, esce 0", async () => {
    const deps = makeDeps(
      vi.fn(async () => ok()) as unknown as typeof fetch,
      SETTINGS_WITH_MARKETPLACE,
    );
    vi.mocked(deps.writeFile).mockImplementation(async (path) => {
      if (path === SETTINGS) throw new Error("EACCES");
    });

    expect(await runSetup(ARGS, deps)).toBe(0);
    expect(deps.logs.join("\n")).toContain(
      "/plugin → Marketplaces → stubwise → Enable auto-update",
    );
  });

  it("--no-auto-update: non legge né scrive settings.json", async () => {
    const deps = makeDeps(
      vi.fn(async () => ok()) as unknown as typeof fetch,
      SETTINGS_WITH_MARKETPLACE,
    );

    expect(await runSetup([...ARGS, "--no-auto-update"], deps)).toBe(0);
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(settingsWrites(deps)).toHaveLength(0);
    expect(deps.logs.join("\n")).not.toContain("Aggiornamenti automatici");
  });

  it("token rifiutato: settings.json non si tocca", async () => {
    const deps = makeDeps(
      vi.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch,
      SETTINGS_WITH_MARKETPLACE,
    );

    expect(await runSetup(ARGS, deps)).toBe(1);
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it("il token non compare nei messaggi del passo aggiornamenti", async () => {
    const deps = makeDeps(vi.fn(async () => ok()) as unknown as typeof fetch, "{ rotto");
    await runSetup(ARGS, deps);
    expect(deps.logs.join("\n")).not.toContain("stw_pat_x");
  });
});

describe("claudeSettingsPath", () => {
  it("rispetta CLAUDE_CONFIG_DIR", () => {
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: "/altrove/claude" }, "/home/u")).toBe(
      join("/altrove/claude", "settings.json"),
    );
  });

  it("senza CLAUDE_CONFIG_DIR (o vuota) usa ~/.claude", () => {
    expect(claudeSettingsPath({}, "/home/u")).toBe(join("/home/u", ".claude", "settings.json"));
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: "" }, "/home/u")).toBe(
      join("/home/u", ".claude", "settings.json"),
    );
  });
});
