import { randomBytes, randomUUID } from "node:crypto";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { pluginJobs, plugins, projectPlugins, projects, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { requestSmoke } from "../services/plugins.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;

/** Registra un plugin via API e restituisce la risposta grezza. */
async function post(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/plugins",
    headers: { cookie: adminCookie },
    payload,
  });
}

/** Registra un plugin e ne restituisce l'id (fallisce se la POST non è 201). */
async function createPlugin(payload: Record<string, unknown>): Promise<string> {
  const res = await post(payload);
  if (res.statusCode !== 201) throw new Error(`POST /api/plugins: ${res.statusCode} ${res.body}`);
  return (res.json() as { id: string }).id;
}

/** Porta il plugin a `ready` come farebbe il worker dopo la materializzazione. */
async function markReady(id: string, sha = "a".repeat(40)): Promise<void> {
  await testDb.db
    .update(plugins)
    .set({
      status: "ready",
      resolvedSha: sha,
      materializedAt: new Date(),
      inventory: {
        name: "superpowers",
        version: "4.0.3",
        skills: [{ name: "writing-plans", bytes: 100 }],
        commands: [],
        agents: [],
        hooks: [{ key: "SessionStart#0", event: "SessionStart", command: "echo ciao" }],
        hasMcp: false,
      },
    })
    .where(eq(plugins.id, id));
  // Il job accodato alla registrazione resta `queued`: chiuderlo, altrimenti
  // ogni riaccodamento successivo vedrebbe l'indice unico parziale.
  await testDb.db.update(pluginJobs).set({ status: "done" }).where(eq(pluginJobs.pluginId, id));
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

afterEach(async () => {
  await testDb.db.delete(plugins);
  await testDb.db.delete(projects);
});

describe("autorizzazione", () => {
  it("senza sessione tutte le rotte del registro rispondono 401", async () => {
    const id = randomUUID();
    // Payload VALIDI: in Fastify la validazione del body precede i preHandler,
    // quindi un body malformato darebbe 400 prima di arrivare all'auth — qui si
    // vuole verificare l'auth, non l'ordine dei hook.
    const calls = [
      { method: "GET" as const, url: "/api/plugins", payload: undefined },
      {
        method: "POST" as const,
        url: "/api/plugins",
        payload: { sourceUrl: "https://github.com/obra/superpowers", ref: "v1" },
      },
      { method: "GET" as const, url: `/api/plugins/${id}`, payload: undefined },
      { method: "POST" as const, url: `/api/plugins/${id}/update`, payload: { ref: "v1" } },
      { method: "POST" as const, url: `/api/plugins/${id}/smoke`, payload: undefined },
      { method: "DELETE" as const, url: `/api/plugins/${id}`, payload: undefined },
    ];
    for (const call of calls) {
      const res = await app.inject(call);
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(401);
    }
  });

  it("con sessione member risponde 403 (il registro è roba da maintainer)", async () => {
    const id = randomUUID();
    const calls = [
      { method: "GET" as const, url: "/api/plugins" },
      { method: "GET" as const, url: `/api/plugins/${id}` },
      { method: "DELETE" as const, url: `/api/plugins/${id}` },
    ];
    for (const call of calls) {
      const res = await app.inject({ ...call, headers: { cookie: memberCookie } });
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(403);
    }
    const withBody = [
      {
        url: "/api/plugins",
        payload: { sourceUrl: "https://github.com/obra/superpowers", ref: "v4.0.3" },
      },
      { url: `/api/plugins/${id}/update`, payload: { ref: "v4.0.3" } },
      { url: `/api/plugins/${id}/smoke`, payload: undefined },
    ];
    for (const call of withBody) {
      const res = await app.inject({
        method: "POST",
        url: call.url,
        headers: { cookie: memberCookie },
        payload: call.payload,
      });
      expect(res.statusCode, `POST ${call.url}`).toBe(403);
    }
  });
});

describe("POST /api/plugins", () => {
  it("registra il plugin, deriva lo slug e accoda subito la materializzazione", async () => {
    const res = await post({ sourceUrl: "https://github.com/obra/superpowers.git", ref: "v4.0.3" });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body.slug).toBe("superpowers");
    expect(body.name).toBe("superpowers");
    expect(body.ref).toBe("v4.0.3");
    expect(body.status).toBe("none");
    expect(body.smokeStatus).toBe("idle");
    expect(body.resolvedSha).toBeNull();
    expect(body.inventory).toBeNull();
    expect(body.sourceSubdir).toBeNull();
    // Il flip di `status` arriva solo al claim del worker: senza questo campo la
    // UI non saprebbe che c'è già qualcosa in coda.
    expect(body.pendingJobKind).toBe("materialize");

    const jobs = await testDb.db
      .select()
      .from(pluginJobs)
      .where(eq(pluginJobs.pluginId, body.id as string));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.kind).toBe("materialize");
    expect(jobs[0]?.status).toBe("queued");
  });

  it("con una subdir lo slug viene dalla subdir", async () => {
    const res = await post({
      sourceUrl: "https://github.com/acme/monorepo.git",
      ref: "main",
      sourceSubdir: "plugins/my-plugin",
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { slug: string }).slug).toBe("my-plugin");
  });

  it("rifiuta con 400 (mai 500) URL malformati, non https, con credenziali o subdir di traversal", async () => {
    const bad = [
      {},
      { ref: "main" },
      { sourceUrl: "https://github.com/a/b" },
      { sourceUrl: "non-un-url", ref: "main" },
      { sourceUrl: "https://", ref: "main" },
      { sourceUrl: "https://%", ref: "main" },
      { sourceUrl: "http://github.com/a/b", ref: "main" },
      { sourceUrl: "git@github.com:a/b.git", ref: "main" },
      { sourceUrl: "https://user:token@github.com/a/b", ref: "main" },
      { sourceUrl: "https://github.com/a/b", ref: "" },
      { sourceUrl: "https://github.com/a/b", ref: "main", sourceSubdir: "../etc" },
      { sourceUrl: "https://github.com/a/b", ref: "main", sourceSubdir: "/abs" },
      { sourceUrl: "https://github.com/a/b", ref: "main", sourceSubdir: "a\\b" },
    ];
    for (const payload of bad) {
      const res = await post(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("rifiuta con 400 le sorgenti da cui non si ricava uno slug (anche di traversal)", async () => {
    // Nessuno di questi deve entrare nel registro con uno slug storto: lo slug è
    // un componente di percorso sul volume del worker.
    const hostile = [
      { sourceUrl: "https://github.com", ref: "main" },
      { sourceUrl: "https://github.com/", ref: "main" },
      { sourceUrl: "https://github.com/a/%2e%2e", ref: "main" },
      { sourceUrl: "https://github.com/a/..", ref: "main" },
      { sourceUrl: "https://github.com/a/....git", ref: "main" },
      { sourceUrl: "https://github.com/a/---", ref: "main" },
      { sourceUrl: "https://github.com/a/%20", ref: "main" },
    ];
    for (const payload of hostile) {
      const res = await post(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect((res.json() as { code: string }).code).toBe("invalid_plugin_slug");
    }
    expect(await testDb.db.select().from(plugins)).toHaveLength(0);
  });

  it("normalizza gli slug ostili che restano derivabili, senza mai uscire dal pattern", async () => {
    const cases: Array<[string, string]> = [
      ["https://github.com/a/%2fetc%2fpasswd", "etc-passwd"],
      ["https://github.com/a/..%2fetc%2fpasswd", "etc-passwd"],
      ["https://github.com/a/MAIUSCOLE", "maiuscole"],
      ["https://github.com/a/$(whoami)", "whoami"],
      [`https://github.com/a/${"n".repeat(80)}`, "n".repeat(64)],
    ];
    for (const [sourceUrl, expected] of cases) {
      const res = await post({ sourceUrl, ref: "main" });
      expect(res.statusCode, sourceUrl).toBe(201);
      const slug = (res.json() as { slug: string }).slug;
      expect(slug, sourceUrl).toBe(expected);
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
      await testDb.db.delete(plugins);
    }
  });

  it("rifiuta con 409 uno slug già in registro, senza lasciare job orfani", async () => {
    await createPlugin({ sourceUrl: "https://github.com/obra/superpowers", ref: "v4.0.3" });
    // Stesso ultimo segmento, altro owner: lo slug collide.
    const res = await post({ sourceUrl: "https://github.com/altro/superpowers", ref: "main" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("plugin_slug_taken");
    expect(await testDb.db.select().from(plugins)).toHaveLength(1);
    expect(await testDb.db.select().from(pluginJobs)).toHaveLength(1);
  });
});

describe("GET /api/plugins", () => {
  it("elenca il registro ed espone le raccomandazioni per i plugin noti", async () => {
    await createPlugin({ sourceUrl: "https://github.com/obra/superpowers", ref: "v4.0.3" });
    const res = await app.inject({
      method: "GET",
      url: "/api/plugins",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      plugins: Array<{ slug: string }>;
      recommendations: Record<string, string[]>;
    };
    expect(body.plugins.map((p) => p.slug)).toEqual(["superpowers"]);
    expect(body.recommendations.superpowers).toEqual([
      "using-git-worktrees",
      "finishing-a-development-branch",
      "dispatching-parallel-agents",
      "subagent-driven-development",
    ]);
  });

  it("GET /:id restituisce il plugin, 404 se non c'è", async () => {
    const id = await createPlugin({ sourceUrl: "https://github.com/obra/superpowers", ref: "v1" });
    const ok = await app.inject({
      method: "GET",
      url: `/api/plugins/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { id: string }).id).toBe(id);

    const missing = await app.inject({
      method: "GET",
      url: `/api/plugins/${randomUUID()}`,
      headers: { cookie: adminCookie },
    });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { code: string }).code).toBe("plugin_not_found");
  });

  it("degrada a null un inventario illeggibile invece di far fallire la lista", async () => {
    const id = await createPlugin({ sourceUrl: "https://github.com/obra/superpowers", ref: "v1" });
    await testDb.db
      .update(plugins)
      // Forma di una versione precedente/futura del formato: non deve mai
      // tradursi in un 500 sull'intero registro.
      .set({ inventory: { qualcosa: "di inatteso" } as never })
      .where(eq(plugins.id, id));
    const res = await app.inject({
      method: "GET",
      url: "/api/plugins",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(
      (res.json() as { plugins: Array<{ inventory: unknown }> }).plugins[0]?.inventory,
    ).toBeNull();
  });
});

describe("pendingJobKind", () => {
  it("resta valorizzato finché il job è vivo, in lista e nel dettaglio", async () => {
    const id = await createPlugin({ sourceUrl: "https://github.com/obra/superpowers", ref: "v1" });

    const read = async () => {
      const list = await app.inject({
        method: "GET",
        url: "/api/plugins",
        headers: { cookie: adminCookie },
      });
      const detail = await app.inject({
        method: "GET",
        url: `/api/plugins/${id}`,
        headers: { cookie: adminCookie },
      });
      const fromList = (list.json() as { plugins: Array<{ pendingJobKind: string | null }> })
        .plugins[0]?.pendingJobKind;
      const fromDetail = (detail.json() as { pendingJobKind: string | null }).pendingJobKind;
      // Le due superfici devono dire la stessa cosa: la UI usa entrambe.
      expect(fromList).toBe(fromDetail);
      return fromDetail;
    };

    // Job `queued` (appena registrato) e `running` (claimato dal worker) sono
    // entrambi "in volo": è la finestra in cui `status` non è ancora cambiato.
    expect(await read()).toBe("materialize");
    await testDb.db
      .update(pluginJobs)
      .set({ status: "running" })
      .where(eq(pluginJobs.pluginId, id));
    expect(await read()).toBe("materialize");

    // Job chiuso: nessun lavoro in volo, la UI può smettere di pollare.
    await testDb.db.update(pluginJobs).set({ status: "done" }).where(eq(pluginJobs.pluginId, id));
    expect(await read()).toBeNull();
  });

  it("con materialize e smoke entrambi vivi vince materialize", async () => {
    const id = await createPlugin({ sourceUrl: "https://github.com/obra/superpowers", ref: "v1" });
    // L'indice unico parziale è su (plugin_id, kind): i due kind possono
    // convivere, e la UI deve vedere quello che cambia `status`.
    await testDb.db.insert(pluginJobs).values({ pluginId: id, kind: "smoke" });
    const res = await app.inject({
      method: "GET",
      url: `/api/plugins/${id}`,
      headers: { cookie: adminCookie },
    });
    expect((res.json() as { pendingJobKind: string }).pendingJobKind).toBe("materialize");
  });

  it("dopo update e smoke riflette il kind appena accodato", async () => {
    const id = await createPlugin({ sourceUrl: "https://github.com/obra/superpowers", ref: "v1" });
    await markReady(id);

    const detail = async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/plugins/${id}`,
        headers: { cookie: adminCookie },
      });
      return (res.json() as { status: string; pendingJobKind: string | null }).pendingJobKind;
    };
    expect(await detail()).toBeNull();

    await app.inject({
      method: "POST",
      url: `/api/plugins/${id}/smoke`,
      headers: { cookie: adminCookie },
    });
    expect(await detail()).toBe("smoke");
    await testDb.db.update(pluginJobs).set({ status: "done" }).where(eq(pluginJobs.pluginId, id));

    await app.inject({
      method: "POST",
      url: `/api/plugins/${id}/update`,
      headers: { cookie: adminCookie },
      payload: { ref: "v2" },
    });
    // `status` è ancora `ready` (il worker non ha claimato): è esattamente il
    // caso in cui pollare su `status` non funzionerebbe.
    const res = await app.inject({
      method: "GET",
      url: `/api/plugins/${id}`,
      headers: { cookie: adminCookie },
    });
    const body = res.json() as { status: string; pendingJobKind: string | null };
    expect(body.status).toBe("ready");
    expect(body.pendingJobKind).toBe("materialize");
  });
});

describe("POST /api/plugins/:id/update", () => {
  it("cambia il ref, accoda la materializzazione e avanza updatedAt", async () => {
    const id = await createPlugin({ sourceUrl: "https://github.com/obra/superpowers", ref: "v1" });
    await markReady(id);
    const [before] = await testDb.db.select().from(plugins).where(eq(plugins.id, id));

    const res = await app.inject({
      method: "POST",
      url: `/api/plugins/${id}/update`,
      headers: { cookie: adminCookie },
      payload: { ref: "v2" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: true });

    const [after] = await testDb.db.select().from(plugins).where(eq(plugins.id, id));
    expect(after?.ref).toBe("v2");
    // `updatedAt` non ha `$onUpdate`: se il servizio se lo dimenticasse, questo
    // confronto sarebbe l'unico a notarlo.
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());

    const queued = await testDb.db.select().from(pluginJobs).where(eq(pluginJobs.status, "queued"));
    expect(queued).toHaveLength(1);
    expect(queued[0]?.kind).toBe("materialize");
  });

  it("409 se una materializzazione è già in volo, e il ref NON cambia", async () => {
    const id = await createPlugin({ sourceUrl: "https://github.com/obra/superpowers", ref: "v1" });
    // Il job accodato dalla registrazione è ancora queued: è il caso reale.
    const res = await app.inject({
      method: "POST",
      url: `/api/plugins/${id}/update`,
      headers: { cookie: adminCookie },
      payload: { ref: "v2" },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("plugin_job_pending");

    const [row] = await testDb.db.select().from(plugins).where(eq(plugins.id, id));
    expect(row?.ref).toBe("v1");
    expect(await testDb.db.select().from(pluginJobs)).toHaveLength(1);
  });

  it("404 su un plugin inesistente, 400 su un body senza ref", async () => {
    const missing = await app.inject({
      method: "POST",
      url: `/api/plugins/${randomUUID()}/update`,
      headers: { cookie: adminCookie },
      payload: { ref: "v2" },
    });
    expect(missing.statusCode).toBe(404);

    const id = await createPlugin({ sourceUrl: "https://github.com/obra/superpowers", ref: "v1" });
    const bad = await app.inject({
      method: "POST",
      url: `/api/plugins/${id}/update`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("POST /api/plugins/:id/smoke", () => {
  it("accoda lo smoke e porta smokeStatus a pending", async () => {
    const id = await createPlugin({ sourceUrl: "https://github.com/obra/superpowers", ref: "v1" });
    await markReady(id);
    await testDb.db
      .update(plugins)
      .set({ smokeStatus: "failed", smokeError: "vecchio errore" })
      .where(eq(plugins.id, id));

    const res = await app.inject({
      method: "POST",
      url: `/api/plugins/${id}/smoke`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(202);

    const [row] = await testDb.db.select().from(plugins).where(eq(plugins.id, id));
    expect(row?.smokeStatus).toBe("pending");
    expect(row?.smokeError).toBeNull();
    const queued = await testDb.db.select().from(pluginJobs).where(eq(pluginJobs.status, "queued"));
    expect(queued.map((j) => j.kind)).toEqual(["smoke"]);
  });

  it("409 se il plugin non è mai stato materializzato", async () => {
    const id = await createPlugin({ sourceUrl: "https://github.com/obra/superpowers", ref: "v1" });
    const res = await app.inject({
      method: "POST",
      url: `/api/plugins/${id}/smoke`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("plugin_not_ready");
  });

  it("409 se uno smoke è già in volo", async () => {
    const id = await createPlugin({ sourceUrl: "https://github.com/obra/superpowers", ref: "v1" });
    await markReady(id);
    const first = await app.inject({
      method: "POST",
      url: `/api/plugins/${id}/smoke`,
      headers: { cookie: adminCookie },
    });
    expect(first.statusCode).toBe(202);
    const second = await app.inject({
      method: "POST",
      url: `/api/plugins/${id}/smoke`,
      headers: { cookie: adminCookie },
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { code: string }).code).toBe("plugin_job_pending");
  });

  it("404 su un plugin inesistente", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/plugins/${randomUUID()}/smoke`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("finestre di scrittura", () => {
  it("un plugin rimosso fra la lettura e l'accodamento dello smoke dà not_found, non un 500", async () => {
    const id = await createPlugin({ sourceUrl: "https://github.com/obra/superpowers", ref: "v1" });
    await markReady(id);

    // La finestra è reale ma stretta: la si apre di proposito cancellando il
    // plugin nell'istante esatto in cui il servizio apre la transazione, così
    // l'insert del job trova la FK già violata. Senza la cattura sarebbe un 500.
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

    await expect(requestSmoke(racing, id)).resolves.toEqual({ ok: false, error: "not_found" });
  });
});

describe("DELETE /api/plugins/:id", () => {
  it("rimuove il plugin e i suoi job", async () => {
    const id = await createPlugin({ sourceUrl: "https://github.com/obra/superpowers", ref: "v1" });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/plugins/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);
    expect(await testDb.db.select().from(plugins)).toHaveLength(0);
    expect(await testDb.db.select().from(pluginJobs)).toHaveLength(0);
  });

  it("409 plugin_in_use se è abilitato su un progetto", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const id = await createPlugin({ sourceUrl: "https://github.com/obra/superpowers", ref: "v1" });
    await testDb.db.insert(projectPlugins).values({ projectId, pluginId: id, enabled: true });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/plugins/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("plugin_in_use");
    expect(await testDb.db.select().from(plugins)).toHaveLength(1);
  });

  it("un'abilitazione SPENTA non blocca la rimozione (e sparisce in cascata)", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const id = await createPlugin({ sourceUrl: "https://github.com/obra/superpowers", ref: "v1" });
    await testDb.db.insert(projectPlugins).values({ projectId, pluginId: id, enabled: false });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/plugins/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);
    expect(await testDb.db.select().from(projectPlugins)).toHaveLength(0);
  });

  it("404 su un plugin inesistente", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/plugins/${randomUUID()}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
