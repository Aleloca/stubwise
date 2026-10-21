import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentSessionEvents,
  agentSessionInputs,
  agentSessions,
  backlogItems,
  backlogRefineSessions,
  instanceSettings,
  plugins,
  projectPlugins,
  users,
  type Db,
} from "@stubwise/db";
import { seedBacklogItem, startTestDb, type TestDb } from "@stubwise/db/testing";
import { REFINE_MCP_SERVER_NAME } from "@stubwise/shared";
import {
  AgentRunCancelledError,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRunner,
} from "../../agent/runner.js";
import { scopedReadTools } from "../../agent/read-scope.js";
import { oneModelUsage, trackedRunner, usageRows } from "../../agent/tracking-fake.js";
import { t as tr } from "@stubwise/i18n";
import type { ResolvedProvider } from "../../providers/chain.js";
import { fakeSelect } from "../../providers/select-fake.js";
import { getContentLanguage } from "../../settings.js";
import { SessionInputRelay } from "../../sessions/relay.js";
import { startRefineBridge, type RefineBridge } from "./bridge.js";
import { refineAllowedTools, refineDisallowedTools, runRefineTurn, type RefineTurnDeps } from "./turn.js";
import { createRefineWorktreeRegistry, refineParentDir } from "./worktrees.js";

let t: TestDb;
let bridge: RefineBridge;
let adminId: string;
let memberId: string;
beforeAll(async () => {
  t = await startTestDb();
  bridge = await startRefineBridge({ db: t.db, log: () => undefined });
  const [a] = await t.db.insert(users).values({ email: "a@x.test", passwordHash: "x", role: "admin" }).returning();
  const [m] = await t.db.insert(users).values({ email: "m@x.test", passwordHash: "x", role: "member" }).returning();
  adminId = a!.id;
  memberId = m!.id;
}, 120_000);
afterAll(async () => {
  await bridge.close();
  await t.stop();
});

const OK: AgentRunResult = { exitCode: 0, output: "fatto", sessionId: "cli-1" };

/** Runner finto: registra le opzioni; `script` decide l'esito di ogni chiamata. */
function fakeRunner(script: Array<(o: AgentRunOptions) => Promise<AgentRunResult>>) {
  const calls: AgentRunOptions[] = [];
  const runner: AgentRunner = {
    recordsSessions: true,
    run: vi.fn(async (o: AgentRunOptions) => {
      calls.push(o);
      return (script[calls.length - 1] ?? script.at(-1)!)(o);
    }),
  };
  return { runner, calls };
}

/** Il CLI ha PRESO il messaggio: l'evento input che il runner vero scriverebbe all'eco. */
async function echo(o: AgentRunOptions) {
  await t.db.insert(agentSessionEvents).values({
    sessionId: o.session!.sessionId,
    segmentId: "seg",
    type: "input",
    data: { inputId: o.openingInput!.inputId, text: o.openingInput!.text },
  });
}

async function seeded(opts: { cliSessionId?: string; status?: "active" | "closed"; author?: string } = {}) {
  const { itemId } = await seedBacklogItem(t.db, { title: "Export CSV" });
  const [s] = await t.db
    .insert(agentSessions)
    .values({ ownerKey: `backlog_refine:${itemId}`, kind: "backlog_refine", title: "t", backlogItemId: itemId })
    .returning();
  await t.db.insert(backlogRefineSessions).values({
    itemId,
    agentSessionId: s!.id,
    status: opts.status ?? "active",
    cliSessionId: opts.cliSessionId ?? null,
    ...(opts.status === "closed" ? { closedAt: new Date(), closedReason: "user" as const } : {}),
  });
  const [input] = await t.db
    .insert(agentSessionInputs)
    .values({ sessionId: s!.id, text: "ciao", authorUserId: opts.author ?? adminId })
    .returning();
  return { itemId, agentSessionId: s!.id, inputId: input!.id };
}

function deps(runner: AgentRunner, over: Partial<RefineTurnDeps> = {}) {
  const openProjectWorktrees = vi.fn(
    async (repos: { repositoryId: string; name: string }[], _branch: string, parentDir: string) => {
      await mkdir(parentDir, { recursive: true });
      return {
        dirs: repos.map((r) => ({ repositoryId: r.repositoryId, name: r.name, dir: `${parentDir}/${r.name}` })),
        remove: vi.fn(async () => undefined),
      };
    },
  );
  const d: RefineTurnDeps = {
    db: t.db,
    runner,
    bridge,
    mirrors: { openProjectWorktrees } as unknown as RefineTurnDeps["mirrors"],
    serializer: { run: (_id: string, fn: () => Promise<unknown>) => fn() } as unknown as RefineTurnDeps["serializer"],
    worktrees: createRefineWorktreeRegistry(),
    encryptionKey: Buffer.alloc(32, 1),
    maxTurns: 30,
    turnTimeoutMs: 60_000,
    refineServerPath: "/nope/index.js",
    // Nessun provider abilitato: auth storica del container.
    select: fakeSelect(t.db, "legacy"),
    loadMirrorProjectsFn: async (_db: Db, projectId: string) => [
      { repositoryId: projectId, name: "api", project: {} as never },
    ],
    log: () => undefined,
    ...over,
  };
  return { d, openProjectWorktrees };
}
const inputOf = async (id: string) =>
  (await t.db.select().from(agentSessionInputs).where(eq(agentSessionInputs.id, id)))[0]!;
const refineOf = async (sid: string) =>
  (await t.db.select().from(backlogRefineSessions).where(eq(backlogRefineSessions.agentSessionId, sid)))[0]!;
const run = (d: RefineTurnDeps, s: { agentSessionId: string; inputId: string }, signal = new AbortController().signal) =>
  runRefineTurn(d, { ...s, signal });
const tick = () => new Promise((r) => setTimeout(r, 30));

describe("runRefineTurn", () => {
  it("consumi: il turno scrive una riga backlog_refine col progetto della voce", async () => {
    const s = await seeded();
    const { runner } = fakeRunner([
      async (o) => {
        await echo(o);
        return { ...OK, usage: oneModelUsage() };
      },
    ]);
    expect(await run(deps(trackedRunner(t.db, runner)).d, s)).toBe("completed");
    const [item] = await t.db
      .select({ projectId: backlogItems.projectId })
      .from(backlogItems)
      .where(eq(backlogItems.id, s.itemId));
    const rows = (await usageRows(t.db)).filter((r) => r.projectId === item!.projectId);
    expect(rows.map((r) => r.operation)).toEqual(["backlog_refine"]);
  });

  it("primo turno: prompt d'avvio, nessun --resume, sola lettura per costruzione, cli_session_id salvato", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([
      async (o) => {
        await echo(o);
        return OK;
      },
    ]);
    expect(await run(deps(runner, { pluginsDir: "/srv/plugins-volume" }).d, s)).toBe("completed");
    const o = calls[0]!;
    expect(o.prompt).toContain("Export CSV");
    expect(o.resumeSessionId).toBeUndefined();
    expect(o.permissionMode).toBe("default");
    expect(o.cwd).toBe(refineParentDir(s.agentSessionId));
    expect(o.timeoutMs).toBe(60_000);
    expect(o.openingInput).toEqual({ inputId: s.inputId, text: "ciao", authorUserId: adminId });
    expect(o.session).toMatchObject({ sessionId: s.agentSessionId, label: "refine" });
    expect(o.session!.pauseKey).toMatch(new RegExp(`^backlog_refine:${s.agentSessionId}:`));
    for (const forbidden of ["Edit", "Write", "Bash", "WebFetch", "NotebookEdit", "MultiEdit", "Read", "Grep", "Glob"]) {
      expect(o.allowedTools).not.toContain(forbidden);
    }
    // Senza grafi e senza entry MCP: le letture SOLO sotto la parent dir dei
    // worktree (mai nude: golden `refine-read`) e le skill.
    // (Più la forma reale della dir, se la tmp è dietro un symlink: macOS.)
    const parent = refineParentDir(s.agentSessionId);
    for (const tool of ["Read", "Grep", "Glob"]) expect(o.allowedTools).toContain(`${tool}(/${parent}/**)`);
    expect(o.allowedTools).toEqual([...scopedReadTools(parent), "Skill"]);
    expect(o.allowedTools!.every((tool) => !/^(Write|Edit|MultiEdit|NotebookEdit|WebFetch|Bash)\b/.test(tool))).toBe(true);
    // Deny rule sui percorsi sensibili, difesa in profondità sopra l'allowlist.
    for (const tool of ["Read", "Grep", "Glob"]) {
      expect(o.disallowedTools).toContain(`${tool}(//proc/**)`);
      expect(o.disallowedTools).toContain(`${tool}(//srv/plugins-volume/**)`);
      expect(o.disallowedTools!.some((r) => r.startsWith(`${tool}(/`) && r.endsWith("stubwise-mcp-*/**)"))).toBe(true);
    }
    expect(o.mcpConfig).toBeUndefined();
    expect((await refineOf(s.agentSessionId)).cliSessionId).toBe("cli-1");
    expect((await inputOf(s.inputId)).status).toBe("delivered");
  });

  it("plugin abilitati: si leggono SOLO le copie di questo run, il volume resta negato, le Skill(...) restano", async () => {
    const s = await seeded();
    const [item] = await t.db.select().from(backlogItems).where(eq(backlogItems.id, s.itemId));
    const root = await mkdtemp(join(tmpdir(), "stubwise-plugin-refine-"));
    const pluginsDir = join(root, "plugins");
    const sha = "b".repeat(40);
    const dir = join(pluginsDir, "plugin-refine", sha);
    await mkdir(join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo" }), "utf8");
    await mkdir(join(dir, "skills", "alpha"), { recursive: true });
    await writeFile(join(dir, "skills", "alpha", "SKILL.md"), "---\nname: alpha\n---\n", "utf8");
    const [row] = await t.db
      .insert(plugins)
      .values({
        slug: "plugin-refine",
        name: "demo",
        sourceUrl: "https://example.com/org/demo.git",
        ref: "main",
        resolvedSha: sha,
        status: "ready",
        inventory: { name: "demo", skills: [{ name: "alpha", bytes: 10 }], commands: [], agents: [], hooks: [], hasMcp: false },
        materializedAt: new Date(),
      })
      .returning({ id: plugins.id });
    await t.db.insert(projectPlugins).values({ projectId: item!.projectId, pluginId: row!.id, disabledSkills: ["alpha"] });
    try {
      const { runner, calls } = fakeRunner([
        async (o) => {
          await echo(o);
          return OK;
        },
      ]);
      expect(await run(deps(runner, { pluginsDir }).d, s)).toBe("completed");
      const o = calls[0]!;
      expect(o.pluginDirs).toHaveLength(2);
      for (const pluginDir of o.pluginDirs!) {
        expect(o.allowedTools).toContain(`Read(/${pluginDir}/**)`);
      }
      expect(o.pluginDirs![1]).not.toContain(pluginsDir);
      expect(o.allowedTools!.some((tool) => tool.includes(pluginsDir))).toBe(false);
      expect(o.disallowedTools![0]).toBe("Skill(demo:alpha)");
      expect(o.disallowedTools).toContain(`Read(/${pluginsDir}/**)`);
    } finally {
      await t.db.delete(projectPlugins).where(eq(projectPlugins.pluginId, row!.id));
      await t.db.delete(plugins).where(eq(plugins.id, row!.id));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("con l'entry MCP: i tre tool di scrittura entrano nell'allowlist chiusa", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([
      async (o) => {
        await echo(o);
        return OK;
      },
    ]);
    // Un file che esiste: la config MCP c'è.
    expect(await run(deps(runner, { refineServerPath: process.execPath }).d, s)).toBe("completed");
    const o = calls[0]!;
    const reads = scopedReadTools(refineParentDir(s.agentSessionId));
    expect(o.allowedTools!.slice(0, reads.length + 1)).toEqual([...reads, "Skill"]);
    expect(o.allowedTools!.slice(reads.length + 1).every((n) => n.startsWith(`mcp__${REFINE_MCP_SERVER_NAME}__`))).toBe(true);
    expect(o.allowedTools).toHaveLength(reads.length + 4);
    const env = o.mcpConfig!.servers[REFINE_MCP_SERVER_NAME]!.env!;
    expect(Object.keys(env).sort()).toEqual(["REFINE_BRIDGE_SECRET", "REFINE_BRIDGE_URL"]);
  });

  it("turno successivo: --resume col cli_session_id, prompt = solo il messaggio, worktree NON riaperti", async () => {
    const s = await seeded({ cliSessionId: "cli-0" });
    const { runner, calls } = fakeRunner([
      async (o) => {
        await echo(o);
        return OK;
      },
    ]);
    const { d, openProjectWorktrees } = deps(runner);
    await run(d, s);
    expect(calls[0]!.resumeSessionId).toBe("cli-0");
    const [second] = await t.db
      .insert(agentSessionInputs)
      .values({ sessionId: s.agentSessionId, text: "e il piano?", authorUserId: adminId })
      .returning();
    expect(await run(d, { agentSessionId: s.agentSessionId, inputId: second!.id })).toBe("completed");
    expect(calls[1]!.resumeSessionId).toBe("cli-1");
    expect(calls[1]!.prompt).toBe("e il piano?");
    expect(calls[1]!.session!.pauseKey).not.toBe(calls[0]!.session!.pauseKey);
    expect(openProjectWorktrees).toHaveBeenCalledTimes(1);
  });

  it("entry già nel registro: la riusa, mai riaperta né sovrascritta", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([
      async (o) => {
        await echo(o);
        return OK;
      },
    ]);
    const { d, openProjectWorktrees } = deps(runner);
    const remove = vi.fn(async () => undefined);
    const existing = { agentSessionId: s.agentSessionId, parentDir: "/gia/aperti", repos: [], remove };
    d.worktrees.set(existing);
    expect(await run(d, s)).toBe("completed");
    expect(openProjectWorktrees).not.toHaveBeenCalled();
    expect(calls[0]!.cwd).toBe("/gia/aperti");
    expect(d.worktrees.get(s.agentSessionId)).toBe(existing);
    expect(remove).not.toHaveBeenCalled();
  });

  it("riavvio + --resume rifiutato: stesso percorso, un tentativo col prompt d'avvio e cli_session_id riscritto", async () => {
    const s = await seeded({ cliSessionId: "cli-perso" });
    const { runner, calls } = fakeRunner([
      async (o) => {
        // Come il relay a fine segmento senza eco: l'input torna `pending`.
        await t.db
          .update(agentSessionInputs)
          .set({ status: "pending", deliveredAt: null })
          .where(eq(agentSessionInputs.id, o.openingInput!.inputId));
        return { exitCode: 1, output: "No conversation found" };
      },
      async (o) => {
        await echo(o);
        return { ...OK, sessionId: "cli-nuovo" };
      },
    ]);
    const { d, openProjectWorktrees } = deps(runner); // registro VUOTO: come dopo un riavvio
    expect(await run(d, s)).toBe("completed");
    expect(openProjectWorktrees.mock.calls[0]![2]).toBe(refineParentDir(s.agentSessionId));
    expect(openProjectWorktrees.mock.calls[0]![1]).toBe(`stubwise/backlog-refine-${s.agentSessionId}`);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.resumeSessionId).toBe("cli-perso");
    expect(calls[1]!.resumeSessionId).toBeUndefined();
    expect(calls[1]!.prompt).toContain("Export CSV");
    expect(calls[1]!.openingInput!.inputId).toBe(s.inputId);
    expect(calls[1]!.session!.pauseKey).toBe(calls[0]!.session!.pauseKey);
    expect((await refineOf(s.agentSessionId)).cliSessionId).toBe("cli-nuovo");
    expect((await inputOf(s.inputId)).status).toBe("delivered");
  });

  it("--resume fallito DOPO l'eco: nessun nuovo tentativo (il messaggio è già nella conversazione)", async () => {
    const s = await seeded({ cliSessionId: "cli-0" });
    const { runner, calls } = fakeRunner([
      async (o) => {
        await echo(o);
        return { exitCode: 1, output: "boom" };
      },
    ]);
    expect(await run(deps(runner).d, s)).toBe("failed");
    expect(calls).toHaveLength(1);
    expect(await inputOf(s.inputId)).toMatchObject({ status: "delivered", reason: null });
    expect((await refineOf(s.agentSessionId)).cliSessionId).toBe("cli-0");
  });

  it("input già reclamato da altri: skipped, nessun run", async () => {
    const s = await seeded();
    await t.db.update(agentSessionInputs).set({ status: "delivered" }).where(eq(agentSessionInputs.id, s.inputId));
    const { runner, calls } = fakeRunner([async () => OK]);
    expect(await run(deps(runner).d, s)).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("sessione chiusa o voce convertita/archiviata: input undelivered/session_not_live, nessun run", async () => {
    const closed = await seeded({ status: "closed" });
    const converted = await seeded();
    await t.db.update(backlogItems).set({ status: "converted" }).where(eq(backlogItems.id, converted.itemId));
    const archived = await seeded();
    await t.db.update(backlogItems).set({ status: "archived" }).where(eq(backlogItems.id, archived.itemId));
    const { runner, calls } = fakeRunner([async () => OK]);
    for (const s of [closed, converted, archived]) {
      const { d, openProjectWorktrees } = deps(runner);
      expect(await run(d, s)).toBe("skipped");
      expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "session_not_live" });
      expect(openProjectWorktrees).not.toHaveBeenCalled();
    }
    expect(calls).toHaveLength(0);
  });

  it("budget sforato, due ruoli: il member riceve budget_exceeded e niente run né worktree, l'admin passa", async () => {
    await t.db
      .insert(instanceSettings)
      .values({ id: 1, monthlyBudgetUsd: "1" })
      .onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "1" } });
    try {
      const byMember = await seeded({ author: memberId });
      const byAdmin = await seeded({ author: adminId });
      const { runner, calls } = fakeRunner([
        async (o) => {
          await echo(o);
          return OK;
        },
      ]);
      const { d, openProjectWorktrees } = deps(runner, { monthlyCostUsdFn: async () => 5 });
      expect(await run(d, byMember)).toBe("skipped");
      expect(await inputOf(byMember.inputId)).toMatchObject({ status: "undelivered", reason: "budget_exceeded" });
      expect(openProjectWorktrees).not.toHaveBeenCalled();
      expect(await run(d, byAdmin)).toBe("completed");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.openingInput!.inputId).toBe(byAdmin.inputId);
      expect((await inputOf(byAdmin.inputId)).status).toBe("delivered");
    } finally {
      await t.db.update(instanceSettings).set({ monthlyBudgetUsd: null }).where(eq(instanceSettings.id, 1));
    }
  });

  it("turno in attesa del serializer: l'input è ancora pending e la sessione non è viva (stato derivato queued)", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([
      async (o) => {
        await echo(o);
        return OK;
      },
    ]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const serializer = {
      run: async <T>(_id: string, fn: () => Promise<T>) => {
        await gate;
        return fn();
      },
    };
    const { d } = deps(runner, { serializer });
    const turn = run(d, s);
    await tick();
    await tick();
    expect((await inputOf(s.inputId)).status).toBe("pending");
    const [row] = await t.db.select().from(agentSessions).where(eq(agentSessions.id, s.agentSessionId));
    expect(row!.liveSegmentIds).toEqual([]);
    expect(calls).toHaveLength(0);
    release();
    expect(await turn).toBe("completed");
    expect((await inputOf(s.inputId)).status).toBe("delivered");
  });

  it("«Chiudi» mentre il turno aspetta il serializer: cancelled, nessun run, input lasciato pending", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([async () => OK]);
    const ac = new AbortController();
    const serializer = {
      run: async <T>(_id: string, fn: () => Promise<T>) => {
        ac.abort();
        return fn();
      },
    };
    const { d, openProjectWorktrees } = deps(runner, { serializer });
    expect(await run(d, s, ac.signal)).toBe("cancelled");
    expect(calls).toHaveLength(0);
    expect(openProjectWorktrees).not.toHaveBeenCalled();
    expect(d.worktrees.get(s.agentSessionId)).toBeUndefined();
    expect((await inputOf(s.inputId)).status).toBe("pending");
  });

  it("«Chiudi» con il serializer OCCUPATO (fix lungo): il turno torna subito, e liberato il serializer non apre nulla", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([async () => OK]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const serializer = {
      run: async <T>(_id: string, fn: () => Promise<T>) => {
        await gate;
        return fn();
      },
    };
    const { d, openProjectWorktrees } = deps(runner, { serializer });
    const ac = new AbortController();
    const turn = run(d, s, ac.signal);
    await tick();
    ac.abort();
    // Il serializer è ancora fermo: il turno non lo aspetta.
    expect(await turn).toBe("cancelled");
    expect((await inputOf(s.inputId)).status).toBe("pending");
    release();
    await tick();
    expect(openProjectWorktrees).not.toHaveBeenCalled();
    expect(d.worktrees.get(s.agentSessionId)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("«Chiudi» a metà apertura dei worktree: cancelled, i worktree aperti si smontano e non entrano nel registro", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([async () => OK]);
    const { d, openProjectWorktrees } = deps(runner);
    const ac = new AbortController();
    const remove = vi.fn(async () => undefined);
    openProjectWorktrees.mockImplementationOnce(async () => {
      ac.abort();
      await tick();
      return { dirs: [], remove };
    });
    expect(await run(d, s, ac.signal)).toBe("cancelled");
    await tick();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(d.worktrees.get(s.agentSessionId)).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect((await inputOf(s.inputId)).status).toBe("pending");
  });

  it("«Chiudi» dopo l'apertura, prima del claim: cancelled, nessun run, input pending", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([async () => OK]);
    const ac = new AbortController();
    // Il segnale scatta fra l'apertura (worktree già nel registro) e il claim:
    // nel rilascio del segreto del ponte, l'ultimo passo prima del claim.
    const abortingBridge = Object.create(bridge) as RefineBridge;
    abortingBridge.grant = (g) => {
      ac.abort();
      return bridge.grant(g);
    };
    const { d } = deps(runner, { bridge: abortingBridge });
    d.worktrees.set({ agentSessionId: s.agentSessionId, parentDir: "/gia/aperti", repos: [], remove: vi.fn(async () => undefined) });
    expect(await run(d, s, ac.signal)).toBe("cancelled");
    expect(calls).toHaveLength(0);
    expect((await inputOf(s.inputId)).status).toBe("pending");
  });

  it("claim perso dopo l'apertura dei worktree: skipped, nessun run, i worktree restano nel registro", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([async () => OK]);
    const { d, openProjectWorktrees } = deps(runner);
    openProjectWorktrees.mockImplementationOnce(async () => {
      // Nel frattempo il server ha chiuso la sessione e l'input.
      await t.db
        .update(agentSessionInputs)
        .set({ status: "undelivered", reason: "session_not_live" })
        .where(eq(agentSessionInputs.id, s.inputId));
      return { dirs: [], remove: vi.fn(async () => undefined) };
    });
    expect(await run(d, s)).toBe("skipped");
    expect(calls).toHaveLength(0);
    expect(d.worktrees.get(s.agentSessionId)?.parentDir).toBe(refineParentDir(s.agentSessionId));
    expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "session_not_live" });
  });

  it("annullato DOPO l'eco: cancelled, l'input resta delivered e non diventa turn_failed", async () => {
    const s = await seeded();
    const { runner } = fakeRunner([
      async (o) => {
        await echo(o);
        throw new AgentRunCancelledError(null, "", 0);
      },
    ]);
    expect(await run(deps(runner).d, s)).toBe("cancelled");
    expect(await inputOf(s.inputId)).toMatchObject({ status: "delivered", reason: null });
  });

  it("«Chiudi» PRIMA dello spawn (nessun inputsNotEchoed): l'input torna pending, mai delivered senza eco", async () => {
    const s = await seeded();
    const abort = new AbortController();
    const { runner } = fakeRunner([
      async () => {
        // Come StreamingClaudeRunner.run con il segnale già scattato: lancia subito.
        abort.abort();
        throw new AgentRunCancelledError(null, "", 0);
      },
    ]);
    expect(await run(deps(runner).d, s, abort.signal)).toBe("cancelled");
    // Lo marca la chiusura (`session_not_live`), vedi scheduler.test.ts.
    expect(await inputOf(s.inputId)).toMatchObject({ status: "pending", reason: null });
  });

  it("«Ferma» prima dell'eco: undelivered/stdin_closed, mai di nuovo in coda (nessun turno dopo)", async () => {
    const s = await seeded();
    const turnStarter = { requestTurn: vi.fn() };
    const relay = new SessionInputRelay({ db: t.db, turnStarter, log: () => undefined });
    const { runner, calls } = fakeRunner([
      async (o) => {
        // Il runner vero, a fine segmento senza eco: il relay riporta l'input
        // a `pending` (no-op la richiesta di turno: questo è ancora in corso).
        await relay.inputsNotEchoed(o.session!.sessionId, [o.openingInput!.inputId]);
        throw new AgentRunCancelledError(null, "", 0);
      },
    ]);
    // Il segnale del turno NON scatta: lo «Ferma» è della persona, non una chiusura.
    expect(await run(deps(runner).d, s)).toBe("cancelled");
    expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "stdin_closed" });
    // La sveglia di fine turno dello scheduler: nessuna richiesta nuova.
    await relay.deliverPending(s.agentSessionId);
    expect(turnStarter.requestTurn).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it("primo turno fallito DOPO l'eco: il cli_session_id riportato si salva e il turno dopo riprende la conversazione", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([
      async (o) => {
        await echo(o);
        return { exitCode: 1, output: "max turns", sessionId: "cli-a-meta" };
      },
      async (o) => {
        await echo(o);
        return OK;
      },
    ]);
    const { d } = deps(runner);
    expect(await run(d, s)).toBe("failed");
    expect((await refineOf(s.agentSessionId)).cliSessionId).toBe("cli-a-meta");
    const [second] = await t.db
      .insert(agentSessionInputs)
      .values({ sessionId: s.agentSessionId, text: "allora?", authorUserId: adminId })
      .returning();
    expect(await run(d, { agentSessionId: s.agentSessionId, inputId: second!.id })).toBe("completed");
    expect(calls[1]!.resumeSessionId).toBe("cli-a-meta");
  });

  it("turno fallito SENZA eco ma con un session id riportato: l'id si salva comunque (l'input resta turn_failed)", async () => {
    const s = await seeded();
    const { runner } = fakeRunner([async () => ({ exitCode: 1, output: "rotto", sessionId: "cli-senza-eco" })]);
    expect(await run(deps(runner).d, s)).toBe("failed");
    expect((await refineOf(s.agentSessionId)).cliSessionId).toBe("cli-senza-eco");
    expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "turn_failed" });
  });

  it("primo turno fallito DOPO l'eco senza session id (timeout): il turno dopo riparte col prompt d'avvio CON i messaggi precedenti", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([
      async (o) => {
        await echo(o);
        await t.db.insert(agentSessionEvents).values({
          sessionId: s.agentSessionId,
          segmentId: "seg",
          type: "assistant_text",
          data: { text: "guardo il modulo export" },
        });
        throw new Error("timeout");
      },
      async (o) => {
        await echo(o);
        return OK;
      },
    ]);
    const { d } = deps(runner);
    expect(await run(d, s)).toBe("failed");
    expect((await refineOf(s.agentSessionId)).cliSessionId).toBeNull();
    const [second] = await t.db
      .insert(agentSessionInputs)
      .values({ sessionId: s.agentSessionId, text: "allora?", authorUserId: adminId })
      .returning();
    expect(await run(d, { agentSessionId: s.agentSessionId, inputId: second!.id })).toBe("completed");
    expect(calls[1]!.resumeSessionId).toBeUndefined();
    expect(calls[1]!.prompt).toContain("Export CSV");
    expect(calls[1]!.prompt).toContain("ciao");
    expect(calls[1]!.prompt).toContain("guardo il modulo export");
    // L'apertura del turno è il MESSAGGIO, non una riga della conversazione.
    expect(calls[1]!.prompt.match(/allora\?/g)).toHaveLength(1);
  });

  it("--resume rifiutato anche se il CLI riporta un session id, e se fallisce anche il nuovo tentativo l'id salvato si azzera", async () => {
    const s = await seeded({ cliSessionId: "cli-perso" });
    const { runner, calls } = fakeRunner([
      async () => ({ exitCode: 1, output: "No conversation found", sessionId: "cli-fantasma" }),
      async () => ({ exitCode: 1, output: "ancora rotto" }),
    ]);
    expect(await run(deps(runner).d, s)).toBe("failed");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.resumeSessionId).toBeUndefined();
    expect((await refineOf(s.agentSessionId)).cliSessionId).toBeNull();
    expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "turn_failed" });
  });

  it("--resume rifiutato e nuovo tentativo che LANCIA: l'id salvato si azzera comunque", async () => {
    const s = await seeded({ cliSessionId: "cli-perso" });
    const { runner } = fakeRunner([
      async () => ({ exitCode: 1, output: "No conversation found" }),
      async () => {
        throw new Error("spawn fallito");
      },
    ]);
    expect(await run(deps(runner).d, s)).toBe("failed");
    expect((await refineOf(s.agentSessionId)).cliSessionId).toBeNull();
  });

  it("progetto senza repository: turn_failed, nessun run", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([async () => OK]);
    const { d } = deps(runner, { loadMirrorProjectsFn: async () => [] });
    expect(await run(d, s)).toBe("failed");
    expect(calls).toHaveLength(0);
    expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "turn_failed" });
  });

  it("errore prima che il CLI prenda il messaggio: undelivered/turn_failed, e il segreto del turno è revocato", async () => {
    const s = await seeded();
    let secret = "";
    const { runner } = fakeRunner([
      async (o) => {
        secret = o.mcpConfig?.servers[REFINE_MCP_SERVER_NAME]?.env?.["REFINE_BRIDGE_SECRET"] ?? "";
        throw new Error("provider giù");
      },
    ]);
    const { d } = deps(runner, { refineServerPath: process.execPath }); // un file che esiste: la config MCP c'è
    expect(await run(d, s)).toBe("failed");
    expect(secret).not.toBe("");
    expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "turn_failed" });
    const res = await fetch(`${bridge.url}/tools/set_plan`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ markdown: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("segreto revocato anche a turno riuscito", async () => {
    const s = await seeded();
    let secret = "";
    const { runner } = fakeRunner([
      async (o) => {
        secret = o.mcpConfig!.servers[REFINE_MCP_SERVER_NAME]!.env!["REFINE_BRIDGE_SECRET"]!;
        await echo(o);
        return OK;
      },
    ]);
    expect(await run(deps(runner, { refineServerPath: process.execPath }).d, s)).toBe("completed");
    const res = await fetch(`${bridge.url}/tools/set_plan`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ markdown: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("turno fallito senza eco → turn_failed, nessun secondo turno (il relay non lo rimette in coda)", async () => {
    const s = await seeded();
    const turnStarter = { requestTurn: vi.fn() };
    const relay = new SessionInputRelay({ db: t.db, turnStarter, log: () => undefined });
    const { runner, calls } = fakeRunner([
      async (o) => {
        // Il runner vero, a fine segmento senza eco: il relay riporta l'input
        // a `pending` e chiede un turno (no-op: questo è ancora in corso).
        await relay.inputsNotEchoed(o.session!.sessionId, [o.openingInput!.inputId]);
        return { exitCode: 1, output: "CLI rotto" };
      },
    ]);
    expect(await run(deps(runner).d, s)).toBe("failed");
    expect(turnStarter.requestTurn).toHaveBeenCalledTimes(1);
    expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "turn_failed" });
    // La sveglia di fine turno dello scheduler: nessuna richiesta nuova.
    await relay.deliverPending(s.agentSessionId);
    expect(turnStarter.requestTurn).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it("turno RIUSCITO senza eco del messaggio d'apertura: turn_failed, nessun turno dopo (mai in loop)", async () => {
    const s = await seeded();
    const turnStarter = { requestTurn: vi.fn() };
    const relay = new SessionInputRelay({ db: t.db, turnStarter, log: () => undefined });
    const logs: string[] = [];
    const { runner, calls } = fakeRunner([
      async (o) => {
        // Exit 0 ma il CLI non ha mai preso il messaggio: a fine segmento il
        // relay lo riporta a `pending` e chiede un turno.
        await relay.inputsNotEchoed(o.session!.sessionId, [o.openingInput!.inputId]);
        return OK;
      },
    ]);
    expect(await run(deps(runner, { log: (m) => logs.push(m) }).d, s)).toBe("completed");
    expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "turn_failed" });
    expect(logs.some((m) => m.includes(s.inputId))).toBe(true);
    // La sveglia di fine turno dello scheduler non trova nulla da rimettere in coda.
    await relay.deliverPending(s.agentSessionId);
    expect(turnStarter.requestTurn).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it("turno fallito DOPO l'eco: failed, l'input resta delivered (è nella trascrizione)", async () => {
    const s = await seeded();
    const { runner } = fakeRunner([
      async (o) => {
        await echo(o);
        throw new Error("timeout");
      },
    ]);
    expect(await run(deps(runner).d, s)).toBe("failed");
    expect(await inputOf(s.inputId)).toMatchObject({ status: "delivered", reason: null });
  });
});

describe("runRefineTurn — scelta dell'account", () => {
  const FIRST: ResolvedProvider = { id: "acc-1", kind: "account", secret: "tok-1" };
  const SECOND: ResolvedProvider = { id: "acc-2", kind: "account", secret: "tok-2" };
  const LIMIT: AgentRunResult = { exitCode: 1, output: "You've hit your session limit · resets 6pm (UTC)" };

  it("primo account al limite → usato il secondo nello stesso turno, completed", async () => {
    const s = await seeded({ cliSessionId: "cli-old" });
    const { runner, calls } = fakeRunner([
      async () => LIMIT,
      async (o) => {
        await echo(o);
        return OK;
      },
    ]);

    const outcome = await run(deps(runner, { select: fakeSelect(t.db, [FIRST, SECOND]) }).d, s);

    expect(outcome).toBe("completed");
    expect(calls.map((c) => c.provider?.id)).toEqual(["acc-1", "acc-2"]);
    // Il limite NON è un --resume rifiutato: il secondo account riprende la stessa conversazione.
    expect(calls.map((c) => c.resumeSessionId)).toEqual(["cli-old", "cli-old"]);
    expect((await refineOf(s.agentSessionId)).cliSessionId).toBe("cli-1");
    expect((await inputOf(s.inputId)).status).toBe("delivered");
  });

  it("nessun account disponibile → turn_failed e il messaggio i18n come risposta, nessun run", async () => {
    const s = await seeded();
    const { runner, calls } = fakeRunner([async () => OK]);

    const outcome = await run(
      deps(runner, { select: fakeSelect(t.db, { emptyReason: "all_limited" }) }).d,
      s,
    );

    expect(outcome).toBe("failed");
    expect(calls).toHaveLength(0);
    expect(await inputOf(s.inputId)).toMatchObject({ status: "undelivered", reason: "turn_failed" });
    const texts = await t.db
      .select({ type: agentSessionEvents.type, data: agentSessionEvents.data })
      .from(agentSessionEvents)
      .where(eq(agentSessionEvents.sessionId, s.agentSessionId));
    expect(texts).toEqual([
      { type: "assistant_text", data: { text: tr(await getContentLanguage(t.db), "backlog.noAccountAvailable") } },
    ]);
  });
});

describe("refineAllowedTools / refineDisallowedTools", () => {
  it("allowlist: letture ristrette, grafo e ponte solo se presenti, nessun tool di scrittura", () => {
    const tools = refineAllowedTools("/srv/none/r1", [{}], { tools: ["mcp__x__set_plan"] });
    expect(tools.slice(0, 4)).toEqual([
      "Read(//srv/none/r1/**)",
      "Grep(//srv/none/r1/**)",
      "Glob(//srv/none/r1/**)",
      "Skill",
    ]);
    expect(tools).toContain("mcp__x__set_plan");
    expect(tools.filter((t) => t.startsWith("Bash(")).every((t) => t.startsWith("Bash(graphify "))).toBe(true);
    for (const forbidden of ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch"]) {
      expect(tools).not.toContain(forbidden);
    }
  });

  it("le copie dei plugin di QUESTO run si leggono, una per una: mai un glob né il volume", () => {
    const tools = refineAllowedTools("/srv/none/r1", [], null, ["/app/plugins/stubwise-base", "/srv/none/stubwise-plugins-ab/plugins/demo"]);
    expect(tools).toContain("Read(//app/plugins/stubwise-base/**)");
    expect(tools).toContain("Grep(//srv/none/stubwise-plugins-ab/plugins/demo/**)");
    expect(tools.some((t) => t.includes("stubwise-plugins-*"))).toBe(false);
  });

  it("deny list: le rule dei plugin restano TUTTE, quelle dei percorsi sensibili si aggiungono", () => {
    const deny = refineDisallowedTools({ pluginsDir: "/plugins", pluginDeny: ["Skill(demo:alpha)", "Skill(demo:beta)"] });
    expect(deny.slice(0, 2)).toEqual(["Skill(demo:alpha)", "Skill(demo:beta)"]);
    expect(deny).toContain("Read(//proc/**)");
    expect(deny).toContain("Glob(//plugins/**)");
    expect(new Set(deny).size).toBe(deny.length);
  });
});
