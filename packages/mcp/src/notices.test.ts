import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { StubwiseClient } from "./client.js";
import {
  SessionNotice,
  appendNotice,
  buildNotices,
  claudeConfigDir,
  compareVersions,
  fetchNpmLatestVersion,
  findManualCopies,
  newestVersion,
  normalizeEnvValue,
  sessionNoticeFromEnvironment,
} from "./notices.js";
import { LATEST_PLUGIN_VERSION } from "./plugin-version.js";
import { buildServer } from "./server.js";
import type { ToolContext, ToolResult } from "./tools/types.js";

describe("compareVersions", () => {
  it("confronta per numeri, non per stringhe", () => {
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });

  it("non confronta ciò che non è una versione x.y.z", () => {
    expect(compareVersions("abc", "1.0.0")).toBeNull();
    expect(compareVersions("1.0.0", "")).toBeNull();
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeNull();
  });
});

describe("normalizeEnvValue", () => {
  it("vuoto e ${…} letterale valgono come assenti", () => {
    // Claude Code passa LETTERALE una `${VAR}` non impostata (provato con la
    // 2.1.294): un .mcp.json scritto a mano senza `:-` la manda così.
    expect(normalizeEnvValue(undefined)).toBeUndefined();
    expect(normalizeEnvValue("")).toBeUndefined();
    expect(normalizeEnvValue("  ")).toBeUndefined();
    expect(normalizeEnvValue("${STUBWISE_PLUGIN_VERSION}")).toBeUndefined();
    expect(normalizeEnvValue(" 1.2.0 ")).toBe("1.2.0");
  });
});

describe("buildNotices", () => {
  const latest = "0.3.0";

  it("plugin più vecchio: dice le due versioni e di rifare il comando dalle impostazioni", () => {
    const [notice, ...rest] = buildNotices({ pluginVersion: "0.2.0", latest, manualCopies: [] });
    expect(rest).toEqual([]);
    expect(notice).toContain("0.2.0 → 0.3.0");
    // La strada principale: il comando della pagina web, una volta, che accende
    // anche l'aggiornamento automatico.
    expect(notice).toContain("Impostazioni → Claude Code");
    expect(notice).toContain("una volta");
    expect(notice).toContain("aggiornamento automatico");
    // Il vecchio token si revoca: ogni comando nuovo ne crea uno.
    expect(notice).toContain("Token di accesso");
    // L'alternativa da terminale resta, per chi è pratico.
    expect(notice).toContain(
      "claude plugin marketplace update stubwise && claude plugin update stubwise@stubwise",
    );
    expect(notice).toContain("riavvia Claude Code");
  });

  it("plugin aggiornato o più nuovo: nessun avviso", () => {
    expect(buildNotices({ pluginVersion: "0.3.0", latest, manualCopies: [] })).toEqual([]);
    expect(buildNotices({ pluginVersion: "0.4.0", latest, manualCopies: [] })).toEqual([]);
  });

  it("versione non confrontabile: nessun avviso (mai un falso allarme)", () => {
    expect(buildNotices({ pluginVersion: "dev", latest, manualCopies: [] })).toEqual([]);
  });

  it("server avviato senza il plugin: dice come installarlo", () => {
    const [notice, ...rest] = buildNotices({ pluginVersion: undefined, latest, manualCopies: [] });
    expect(rest).toEqual([]);
    expect(notice).toContain(
      "claude plugin marketplace add Aleloca/stubwise --sparse .claude-plugin plugins",
    );
    expect(notice).toContain("claude plugin install stubwise@stubwise");
    expect(notice).toContain("claude mcp remove stubwise");
  });

  it("copie a mano di skill e comandi: le nomina e dice di cancellarle", () => {
    const copies = ["/home/u/.claude/skills/stubwise", "/home/u/.claude/commands/stubwise"];
    const notices = buildNotices({ pluginVersion: latest, latest, manualCopies: copies });
    expect(notices).toHaveLength(1);
    // Leggibile da chi non usa il terminale: le cartelle nominate, nessun `rm -rf`.
    expect(notices[0]).toContain("/home/u/.claude/skills/stubwise");
    expect(notices[0]).toContain("/home/u/.claude/commands/stubwise");
    expect(notices[0]).not.toContain("rm -rf");
  });

  it("nessun avviso contiene comandi distruttivi da terminale", () => {
    const all = buildNotices({
      pluginVersion: undefined,
      latest,
      manualCopies: ["/x/skills/stubwise"],
    }).concat(buildNotices({ pluginVersion: "0.1.0", latest, manualCopies: [] }));
    expect(all.length).toBeGreaterThan(0);
    for (const n of all) expect(n).not.toContain("rm -rf");
  });

  it("i casi si sommano", () => {
    const notices = buildNotices({
      pluginVersion: "0.1.0",
      latest,
      manualCopies: ["/x/skills/stubwise"],
    });
    expect(notices).toHaveLength(2);
  });
});

describe("findManualCopies", () => {
  it("trova la skill (SKILL.md) e i comandi copiati a mano", () => {
    const dir = "/home/u/.claude";
    const present = new Set([
      join(dir, "skills", "stubwise", "SKILL.md"),
      join(dir, "commands", "stubwise"),
    ]);
    expect(findManualCopies(dir, (p) => present.has(p))).toEqual([
      join(dir, "skills", "stubwise"),
      join(dir, "commands", "stubwise"),
    ]);
  });

  it("nessuna copia, nessun percorso", () => {
    expect(findManualCopies("/home/u/.claude", () => false)).toEqual([]);
  });
});

describe("claudeConfigDir", () => {
  it("rispetta CLAUDE_CONFIG_DIR, altrimenti ~/.claude", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u")).toBe("/cfg");
    expect(claudeConfigDir({}, "/home/u")).toBe(join("/home/u", ".claude"));
  });
});

describe("SessionNotice", () => {
  it("consegna il testo una sola volta", async () => {
    const notice = new SessionNotice(["uno", "due"]);
    expect(await notice.take()).toContain("uno");
    expect(await notice.take()).toBeNull();
  });

  it("senza avvisi non consegna niente", async () => {
    expect(await new SessionNotice([]).take()).toBeNull();
  });

  it("avvisi ancora da calcolare: due risposte concorrenti, uno solo li riceve", async () => {
    let resolve!: (v: string[]) => void;
    const notice = new SessionNotice(new Promise<string[]>((r) => (resolve = r)));
    const a = notice.take();
    const b = notice.take();
    resolve(["avviso"]);
    const got = [await a, await b];
    expect(got.filter((t) => t !== null)).toHaveLength(1);
  });

  it("un calcolo che fallisce non diventa mai un errore", async () => {
    const notice = new SessionNotice(Promise.reject(new Error("boom")));
    expect(await notice.take()).toBeNull();
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchNpmLatestVersion", () => {
  it("legge la versione `latest` di @stubwise/mcp dal registro npm", async () => {
    const f = vi.fn(async () => jsonResponse(200, { name: "@stubwise/mcp", version: "0.12.3" }));
    expect(await fetchNpmLatestVersion(f as unknown as typeof fetch)).toBe("0.12.3");
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe(
      "https://registry.npmjs.org/@stubwise/mcp/latest",
    );
  });

  it("errore di rete, risposta non 200 o versione non valida: null", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchNpmLatestVersion(down as unknown as typeof fetch)).toBeNull();
    const notFound = vi.fn(async () => jsonResponse(404, { error: "not found" }));
    expect(await fetchNpmLatestVersion(notFound as unknown as typeof fetch)).toBeNull();
    const weird = vi.fn(async () => jsonResponse(200, { version: "latest-ish" }));
    expect(await fetchNpmLatestVersion(weird as unknown as typeof fetch)).toBeNull();
    const notJson = vi.fn(async () => new Response("<html>", { status: 200 }));
    expect(await fetchNpmLatestVersion(notJson as unknown as typeof fetch)).toBeNull();
  });

  it("registro lento: si arrende allo scadere del tempo, con null", async () => {
    const never = vi.fn(() => new Promise<Response>(() => {}));
    const started = Date.now();
    expect(await fetchNpmLatestVersion(never as unknown as typeof fetch, 30)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("newestVersion", () => {
  it("la più alta fra la compilata e quella di npm; npm assente o illeggibile = la compilata", () => {
    expect(newestVersion("0.10.0", "0.11.0")).toBe("0.11.0");
    expect(newestVersion("0.10.0", "0.9.9")).toBe("0.10.0");
    expect(newestVersion("0.10.0", null)).toBe("0.10.0");
    expect(newestVersion("0.10.0", "boh")).toBe("0.10.0");
  });
});

describe("sessionNoticeFromEnvironment", () => {
  // Una cartella che non esiste: nessuna copia a mano trovata.
  const base = { CLAUDE_CONFIG_DIR: "/non/esiste/stubwise-test" };

  function bump(version: string): string {
    const [major, minor] = version.split(".").map(Number);
    return `${major}.${(minor ?? 0) + 1}.0`;
  }

  it("plugin = versione compilata ma npm ne ha una più nuova: avvisa", async () => {
    // È il caso normale dal gruppo `fixed`: il plugin X avvia @stubwise/mcp@X,
    // che ha compilata X. Senza npm l'avviso non scatterebbe mai.
    const newer = bump(LATEST_PLUGIN_VERSION);
    const f = vi.fn(async () => jsonResponse(200, { version: newer }));
    const notice = sessionNoticeFromEnvironment(
      { ...base, STUBWISE_PLUGIN_VERSION: LATEST_PLUGIN_VERSION },
      { fetch: f as unknown as typeof fetch },
    );
    expect(await notice.take()).toContain(`${LATEST_PLUGIN_VERSION} → ${newer}`);
  });

  it("npm irraggiungibile: ripiega sulla versione compilata, nessun errore", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const same = sessionNoticeFromEnvironment(
      { ...base, STUBWISE_PLUGIN_VERSION: LATEST_PLUGIN_VERSION },
      { fetch: down as unknown as typeof fetch },
    );
    expect(await same.take()).toBeNull();
    const older = sessionNoticeFromEnvironment(
      { ...base, STUBWISE_PLUGIN_VERSION: "0.0.1" },
      { fetch: down as unknown as typeof fetch },
    );
    expect(await older.take()).toContain(`0.0.1 → ${LATEST_PLUGIN_VERSION}`);
  });

  it("npm lento: la prima risposta non aspetta oltre il tempo massimo", async () => {
    const never = vi.fn(() => new Promise<Response>(() => {}));
    const notice = sessionNoticeFromEnvironment(
      { ...base, STUBWISE_PLUGIN_VERSION: "0.0.1" },
      { fetch: never as unknown as typeof fetch, timeoutMs: 30 },
    );
    const started = Date.now();
    expect(await notice.take()).toContain(`0.0.1 → ${LATEST_PLUGIN_VERSION}`);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("senza plugin non interroga npm", async () => {
    const f = vi.fn();
    const notice = sessionNoticeFromEnvironment(base, { fetch: f as unknown as typeof fetch });
    expect(await notice.take()).toContain("non è installato come plugin");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("appendNotice", () => {
  const ok: ToolResult = { content: [{ type: "text", text: "risposta" }] };

  it("aggiunge un blocco in fondo e lascia intatta la risposta", async () => {
    const out = await appendNotice(ok, new SessionNotice(["avviso"]));
    expect(out.content[0]).toEqual({ type: "text", text: "risposta" });
    expect(out.content).toHaveLength(2);
    expect(out.content[1]?.text).toContain("avviso");
    expect(out.isError).toBeUndefined();
  });

  it("non trasforma mai una risposta in un errore, né un errore in un successo", async () => {
    const err: ToolResult = { content: [{ type: "text", text: "no" }], isError: true };
    expect((await appendNotice(err, new SessionNotice(["avviso"]))).isError).toBe(true);
  });

  it("senza notice la risposta è la stessa", async () => {
    expect(await appendNotice(ok, undefined)).toBe(ok);
  });
});

describe("avviso dentro il server MCP", () => {
  it("compare solo nella prima risposta di un tool della sessione", async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
    const spy = vi.spyOn(McpServer.prototype, "registerTool").mockImplementation(function (
      this: McpServer,
      name: string,
      _cfg: unknown,
      cb: unknown,
    ) {
      handlers.set(name, cb as (args: Record<string, unknown>) => Promise<ToolResult>);
      return {} as ReturnType<McpServer["registerTool"]>;
    });

    const client = {
      listProjects: vi.fn().mockResolvedValue([{ id: "p1", slug: "acme", name: "Acme" }]),
    } as unknown as StubwiseClient;
    const ctx: ToolContext = {
      client,
      config: { baseUrl: "http://localhost:9999", token: "stw_pat_x", projectSlug: null },
      notice: new SessionNotice(["AVVISO-UNICO"]),
    };
    buildServer(ctx);
    spy.mockRestore();

    const listProjects = handlers.get("list_projects");
    expect(listProjects).toBeDefined();
    const first = await listProjects!({});
    const second = await listProjects!({});

    expect(first.content.map((c) => c.text).join("\n")).toContain("AVVISO-UNICO");
    expect(second.content.map((c) => c.text).join("\n")).not.toContain("AVVISO-UNICO");
    // La risposta vera c'è in entrambe.
    expect(first.content[0]?.text).toContain("acme");
    expect(second.content[0]?.text).toContain("acme");
  });
});
