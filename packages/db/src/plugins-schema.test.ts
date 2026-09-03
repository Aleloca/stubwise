import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PluginInventory } from "@stubwise/shared";
import type { Db } from "./client.js";
import { pluginJobs, plugins, projectPlugins, projects } from "./schema.js";
import { expectSqlState, seedRepository, startTestDb, type TestDb } from "./testing.js";

/**
 * Verifica che la migrazione del registro plugin (`plugins` + coda
 * `plugin_jobs` + abilitazioni `project_plugins`) sia applicabile su un Postgres
 * reale: default delle colonne, round-trip dell'inventario jsonb, indice unico
 * parziale che tiene un solo job attivo per (plugin, kind) e cascate sul delete.
 */
describe("schema: registro plugin", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });


  let pluginSeq = 0;

  /** Registra un plugin minimo (solo i campi non nulli) e ne restituisce l'id. */
  async function seedPlugin(): Promise<string> {
    pluginSeq++;
    const [row] = await db
      .insert(plugins)
      .values({
        slug: `plugin-di-test-${pluginSeq}`,
        name: `Plugin di test ${pluginSeq}`,
        sourceUrl: "https://github.com/example/plugin.git",
        ref: "v1.0.0",
      })
      .returning();
    if (!row) throw new Error("insert del plugin di test non ha restituito la riga");
    return row.id;
  }

  it("registra un plugin con i default (status none, smokeStatus idle)", async () => {
    pluginSeq++;
    const [plugin] = await db
      .insert(plugins)
      .values({
        slug: `plugin-default-${pluginSeq}`,
        name: "Plugin di test",
        sourceUrl: "https://github.com/example/plugin.git",
        ref: "main",
      })
      .returning();
    if (!plugin) throw new Error("insert del plugin non ha restituito la riga");

    expect(plugin.status).toBe("none");
    expect(plugin.smokeStatus).toBe("idle");
    expect(plugin.sourceSubdir).toBeNull();
    expect(plugin.resolvedSha).toBeNull();
    expect(plugin.inventory).toBeNull();
    expect(plugin.error).toBeNull();
    expect(plugin.smokeError).toBeNull();
    expect(plugin.materializedAt).toBeNull();
    expect(plugin.createdAt).toBeInstanceOf(Date);
    expect(plugin.updatedAt).toBeInstanceOf(Date);
  });

  it("lo slug è unico nel registro", async () => {
    const slug = "plugin-slug-unico";
    const values = {
      slug,
      name: "Plugin di test",
      sourceUrl: "https://github.com/example/plugin.git",
      ref: "main",
    };
    await db.insert(plugins).values(values);
    await expectSqlState(db.insert(plugins).values(values), "23505");
  });

  it("persiste l'inventario jsonb prodotto dal worker alla materializzazione", async () => {
    const pluginId = await seedPlugin();
    const inventory: PluginInventory = {
      name: "superpowers",
      version: "4.0.3",
      description: "Skill di sviluppo",
      skills: [{ name: "writing-plans", description: "Piani", bytes: 4096 }],
      commands: [{ name: "plan" }],
      agents: [{ name: "code-reviewer" }],
      hooks: [
        {
          key: "SessionStart#0",
          event: "SessionStart",
          matcher: "startup|resume",
          command: "bash hooks/context.sh",
        },
      ],
      hasMcp: false,
    };

    await db
      .update(plugins)
      .set({
        status: "ready",
        resolvedSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6",
        inventory,
        materializedAt: new Date(),
      })
      .where(eq(plugins.id, pluginId));

    const [readBack] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    if (!readBack) throw new Error("read-back del plugin non ha restituito la riga");
    expect(readBack.status).toBe("ready");
    expect(readBack.resolvedSha).toBe("0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6");
    expect(readBack.inventory).toEqual(inventory);
    expect(readBack.materializedAt).toBeInstanceOf(Date);
  });

  it("accoda un job di materializzazione con i default (queued, attempts 0)", async () => {
    const pluginId = await seedPlugin();

    const [job] = await db.insert(pluginJobs).values({ pluginId, kind: "materialize" }).returning();
    if (!job) throw new Error("insert del job di plugin non ha restituito la riga");

    expect(job.kind).toBe("materialize");
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(job.error).toBeNull();
    expect(job.claimedAt).toBeNull();
    expect(job.createdAt).toBeInstanceOf(Date);
  });

  it("indice unico parziale: due job attivi sullo stesso (plugin, kind) → 23505", async () => {
    const pluginId = await seedPlugin();
    await db.insert(pluginJobs).values({ pluginId, kind: "materialize" });

    // Secondo queued: rifiutato con unique_violation (è il vincolo che impedisce
    // due materializzazioni concorrenti dello stesso plugin).
    await expectSqlState(db.insert(pluginJobs).values({ pluginId, kind: "materialize" }), "23505");
    // Anche running collide con queued: entrambi sono stati "attivi".
    await expectSqlState(
      db.insert(pluginJobs).values({ pluginId, kind: "materialize", status: "running" }),
      "23505",
    );
  });

  it("indice unico parziale: kind diversi e job conclusi non collidono", async () => {
    const pluginId = await seedPlugin();

    // Un materialize attivo e uno smoke attivo convivono: l'indice è per (plugin, kind).
    await db.insert(pluginJobs).values({ pluginId, kind: "materialize" });
    const [smoke] = await db.insert(pluginJobs).values({ pluginId, kind: "smoke" }).returning();
    expect(smoke!.kind).toBe("smoke");

    // Lo storico dei job conclusi non partecipa all'indice parziale: done e
    // failed convivono con l'attivo dello stesso kind, quindi un plugin può
    // accumulare N smoke run senza che il vincolo si opponga.
    await db.insert(pluginJobs).values({ pluginId, kind: "smoke", status: "done" });
    await db.insert(pluginJobs).values({ pluginId, kind: "smoke", status: "failed" });

    const rows = await db.select().from(pluginJobs).where(eq(pluginJobs.pluginId, pluginId));
    expect(rows).toHaveLength(4);
  });

  it("abilita un plugin su un progetto con i default (enabled, liste vuote)", async () => {
    const { projectId } = await seedRepository(db);
    const pluginId = await seedPlugin();

    const [row] = await db.insert(projectPlugins).values({ projectId, pluginId }).returning();
    if (!row) throw new Error("insert dell'abilitazione non ha restituito la riga");

    expect(row.enabled).toBe(true);
    expect(row.disabledSkills).toEqual([]);
    expect(row.disabledHooks).toEqual([]);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it("primary key composta: una sola abilitazione per (progetto, plugin)", async () => {
    const { projectId } = await seedRepository(db);
    const pluginId = await seedPlugin();

    await db.insert(projectPlugins).values({ projectId, pluginId });
    await expectSqlState(db.insert(projectPlugins).values({ projectId, pluginId }), "23505");
  });

  it("persiste gli spegnimenti a grana fine di skill e hook", async () => {
    const { projectId } = await seedRepository(db);
    const pluginId = await seedPlugin();

    await db.insert(projectPlugins).values({
      projectId,
      pluginId,
      enabled: false,
      disabledSkills: ["using-git-worktrees", "dispatching-parallel-agents"],
      disabledHooks: ["SessionStart#0"],
    });

    const [row] = await db
      .select()
      .from(projectPlugins)
      .where(and(eq(projectPlugins.projectId, projectId), eq(projectPlugins.pluginId, pluginId)));
    if (!row) throw new Error("read-back dell'abilitazione non ha restituito la riga");
    expect(row.enabled).toBe(false);
    expect(row.disabledSkills).toEqual(["using-git-worktrees", "dispatching-parallel-agents"]);
    expect(row.disabledHooks).toEqual(["SessionStart#0"]);
  });

  it("il delete del plugin cascata su job e abilitazioni", async () => {
    const { projectId } = await seedRepository(db);
    const pluginId = await seedPlugin();
    await db.insert(pluginJobs).values({ pluginId, kind: "materialize" });
    await db.insert(projectPlugins).values({ projectId, pluginId });

    await db.delete(plugins).where(eq(plugins.id, pluginId));

    const jobs = await db.select().from(pluginJobs).where(eq(pluginJobs.pluginId, pluginId));
    expect(jobs).toHaveLength(0);
    const enabled = await db
      .select()
      .from(projectPlugins)
      .where(eq(projectPlugins.pluginId, pluginId));
    expect(enabled).toHaveLength(0);
  });

  it("il delete del progetto cascata sulle sue abilitazioni (il plugin resta)", async () => {
    const { projectId } = await seedRepository(db);
    const pluginId = await seedPlugin();
    await db.insert(projectPlugins).values({ projectId, pluginId });

    await db.delete(projects).where(eq(projects.id, projectId));

    const enabled = await db
      .select()
      .from(projectPlugins)
      .where(eq(projectPlugins.projectId, projectId));
    expect(enabled).toHaveLength(0);
    // Il plugin è d'istanza: sopravvive al progetto che lo aveva abilitato.
    const [plugin] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
    expect(plugin).toBeDefined();
  });
});
