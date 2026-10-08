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
  findManualCopies,
  normalizeEnvValue,
} from "./notices.js";
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

  it("plugin più vecchio: dice le due versioni e i comandi esatti per aggiornare", () => {
    const [notice, ...rest] = buildNotices({ pluginVersion: "0.2.0", latest, manualCopies: [] });
    expect(rest).toEqual([]);
    expect(notice).toContain("0.2.0 → 0.3.0");
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
    expect(notices[0]).toContain("rm -rf /home/u/.claude/skills/stubwise /home/u/.claude/commands/stubwise");
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
  it("consegna il testo una sola volta", () => {
    const notice = new SessionNotice(["uno", "due"]);
    expect(notice.take()).toContain("uno");
    expect(notice.take()).toBeNull();
  });

  it("senza avvisi non consegna niente", () => {
    expect(new SessionNotice([]).take()).toBeNull();
  });
});

describe("appendNotice", () => {
  const ok: ToolResult = { content: [{ type: "text", text: "risposta" }] };

  it("aggiunge un blocco in fondo e lascia intatta la risposta", () => {
    const out = appendNotice(ok, new SessionNotice(["avviso"]));
    expect(out.content[0]).toEqual({ type: "text", text: "risposta" });
    expect(out.content).toHaveLength(2);
    expect(out.content[1]?.text).toContain("avviso");
    expect(out.isError).toBeUndefined();
  });

  it("non trasforma mai una risposta in un errore, né un errore in un successo", () => {
    const err: ToolResult = { content: [{ type: "text", text: "no" }], isError: true };
    expect(appendNotice(err, new SessionNotice(["avviso"])).isError).toBe(true);
  });

  it("senza notice la risposta è la stessa", () => {
    expect(appendNotice(ok, undefined)).toBe(ok);
  });
});

describe("avviso dentro il server MCP", () => {
  it("compare solo nella prima risposta di un tool della sessione", async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
    const spy = vi
      .spyOn(McpServer.prototype, "registerTool")
      .mockImplementation(function (this: McpServer, name: string, _cfg: unknown, cb: unknown) {
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
