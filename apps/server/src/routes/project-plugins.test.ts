import { randomBytes, randomUUID } from "node:crypto";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { plugins, projectPlugins, projects, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { putProjectPlugins } from "../services/plugins.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let projectId: string;

/** Inserisce un plugin `ready` con un inventario noto (una skill, un hook). */
async function seedPlugin(slug: string): Promise<string> {
  const [row] = await testDb.db
    .insert(plugins)
    .values({
      slug,
      name: slug,
      sourceUrl: `https://github.com/acme/${slug}`,
      ref: "v1",
      resolvedSha: "b".repeat(40),
      status: "ready",
      materializedAt: new Date(),
      inventory: {
        name: slug,
        skills: [
          { name: "writing-plans", bytes: 100 },
          { name: "using-git-worktrees", bytes: 200 },
        ],
        commands: [],
        agents: [],
        hooks: [{ key: "SessionStart#0", event: "SessionStart", command: "echo ciao" }],
        hasMcp: false,
      },
    })
    .returning();
  if (!row) throw new Error("insert del plugin di test non ha restituito la riga");
  return row.id;
}

/** PUT dell'insieme completo delle abilitazioni del progetto corrente. */
async function put(body: unknown, cookie = adminCookie) {
  return app.inject({
    method: "PUT",
    url: `/api/projects/${projectId}/plugins`,
    headers: { cookie },
    payload: body as Record<string, unknown>,
  });
}

/** GET delle abilitazioni del progetto corrente. */
async function get(cookie = adminCookie) {
  return app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/plugins`,
    headers: { cookie },
  });
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    embeddingClient: createFakeEmbeddingClient(),
  });
  ({ adminCookie, memberCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  ({ projectId } = await seedRepository(testDb.db));
});

afterEach(async () => {
  await testDb.db.delete(plugins);
  await testDb.db.delete(projects);
});

describe("autorizzazione e progetto", () => {
  it("401 senza sessione, 403 con sessione member", async () => {
    const anonGet = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/plugins`,
    });
    expect(anonGet.statusCode).toBe(401);
    const anonPut = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/plugins`,
      payload: { plugins: [] },
    });
    expect(anonPut.statusCode).toBe(401);

    expect((await get(memberCookie)).statusCode).toBe(403);
    expect((await put({ plugins: [] }, memberCookie)).statusCode).toBe(403);
  });

  it("404 su un progetto inesistente", async () => {
    const missing = randomUUID();
    const g = await app.inject({
      method: "GET",
      url: `/api/projects/${missing}/plugins`,
      headers: { cookie: adminCookie },
    });
    expect(g.statusCode).toBe(404);
    const p = await app.inject({
      method: "PUT",
      url: `/api/projects/${missing}/plugins`,
      headers: { cookie: adminCookie },
      payload: { plugins: [] },
    });
    expect(p.statusCode).toBe(404);
    expect((p.json() as { code: string }).code).toBe("project_not_found");
  });
});

describe("GET/PUT /api/projects/:projectId/plugins", () => {
  it("un progetto senza abilitazioni risponde con la lista vuota", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plugins: [] });
  });

  it("salva le abilitazioni e le rilegge identiche (round-trip)", async () => {
    const id = await seedPlugin("superpowers");
    const body = {
      plugins: [
        {
          pluginId: id,
          enabled: true,
          disabledSkills: ["using-git-worktrees"],
          disabledHooks: ["SessionStart#0"],
        },
      ],
    };
    const res = await put(body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(body);
    expect((await get()).json()).toEqual(body);
  });

  it("il PUT è una SOSTITUZIONE COMPLETA: i plugin assenti spariscono", async () => {
    const a = await seedPlugin("alfa");
    const b = await seedPlugin("beta");
    await put({
      plugins: [
        { pluginId: a, enabled: true, disabledSkills: [], disabledHooks: [] },
        { pluginId: b, enabled: true, disabledSkills: [], disabledHooks: [] },
      ],
    });
    const res = await put({
      plugins: [{ pluginId: b, enabled: false, disabledSkills: [], disabledHooks: [] }],
    });
    expect(res.statusCode).toBe(200);
    const saved = (res.json() as { plugins: Array<{ pluginId: string }> }).plugins;
    expect(saved.map((p) => p.pluginId)).toEqual([b]);
    const rows = await testDb.db
      .select()
      .from(projectPlugins)
      .where(eq(projectPlugins.projectId, projectId));
    expect(rows).toHaveLength(1);
  });

  it("una lista vuota azzera tutte le abilitazioni del progetto", async () => {
    const id = await seedPlugin("superpowers");
    await put({ plugins: [{ pluginId: id, enabled: true }] });
    const res = await put({ plugins: [] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plugins: [] });
  });

  it("avanza updatedAt su un'abilitazione riscritta", async () => {
    const id = await seedPlugin("superpowers");
    await put({ plugins: [{ pluginId: id, enabled: true }] });
    const [before] = await testDb.db
      .select()
      .from(projectPlugins)
      .where(eq(projectPlugins.pluginId, id));

    const res = await put({
      plugins: [{ pluginId: id, enabled: true, disabledSkills: ["writing-plans"] }],
    });
    expect(res.statusCode).toBe(200);
    const [after] = await testDb.db
      .select()
      .from(projectPlugins)
      .where(eq(projectPlugins.pluginId, id));
    expect(after?.disabledSkills).toEqual(["writing-plans"]);
    // La colonna non ha `$onUpdate`: il servizio deve scriverlo a mano.
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });

  it("400 se cita un plugin che non è nel registro", async () => {
    const res = await put({ plugins: [{ pluginId: randomUUID(), enabled: true }] });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("unknown_plugin");
  });

  it("400 se spegne una skill che non esiste nell'inventario, senza scrivere nulla", async () => {
    const id = await seedPlugin("superpowers");
    const res = await put({
      plugins: [{ pluginId: id, enabled: true, disabledSkills: ["using-git-worktree"] }],
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("unknown_plugin_skill");
    expect(await testDb.db.select().from(projectPlugins)).toHaveLength(0);
  });

  it("400 se spegne un hook che non esiste nell'inventario", async () => {
    const id = await seedPlugin("superpowers");
    const res = await put({
      plugins: [{ pluginId: id, enabled: true, disabledHooks: ["SessionStart#7"] }],
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("unknown_plugin_hook");
  });

  it("400 se spegne qualcosa su un plugin mai materializzato (nessun inventario da verificare)", async () => {
    const [row] = await testDb.db
      .insert(plugins)
      .values({
        slug: "mai-visto",
        name: "mai-visto",
        sourceUrl: "https://github.com/acme/mai-visto",
        ref: "v1",
      })
      .returning();
    const id = row!.id;
    // Abilitarlo si può (la materializzazione può arrivare dopo)…
    expect((await put({ plugins: [{ pluginId: id, enabled: true }] })).statusCode).toBe(200);
    // …ma non si può spegnere una voce che nessuno ha ancora elencato.
    const res = await put({
      plugins: [{ pluginId: id, enabled: true, disabledSkills: ["writing-plans"] }],
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("unknown_plugin_skill");
  });

  it("un plugin rimosso fra la validazione e la scrittura dà 400, non un 500", async () => {
    const id = await seedPlugin("superpowers");
    // La validazione sta FUORI dalla transazione (deve leggere l'inventario),
    // quindi la finestra esiste: la si apre cancellando il plugin nell'istante
    // in cui il servizio apre la transazione. La FK di `project_plugins` la
    // intercetta e deve diventare lo stesso 400 di un id sconosciuto.
    const racing = new Proxy(testDb.db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (...args: unknown[]) => {
            await testDb.db.delete(plugins).where(eq(plugins.id, id));
            return (Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown).apply(
              target,
              args,
            );
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as Db;

    const result = await putProjectPlugins(racing, projectId, [
      { pluginId: id, enabled: true, disabledSkills: [], disabledHooks: [] },
    ]);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: "unknown_plugin" });
  });

  it("400 su un body senza `plugins` o con un pluginId ripetuto", async () => {
    const id = await seedPlugin("superpowers");
    expect((await put({})).statusCode).toBe(400);
    const dup = await put({
      plugins: [
        { pluginId: id, enabled: true },
        { pluginId: id, enabled: false },
      ],
    });
    expect(dup.statusCode).toBe(400);
  });
});
