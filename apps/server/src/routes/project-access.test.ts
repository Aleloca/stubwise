import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import {
  backlogItemRequesters,
  backlogItems,
  backlogItemTickets,
  backlogJobs,
  projectBriefs,
  projectDecisions,
  projectEmailRoutes,
  projectEnvironments,
  projectFollows,
  projects,
  tickets,
  widgets,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithPat, seedUsers } from "../test/fixtures.js";

/**
 * Progetto, backlog, decisioni e impostazioni di progetto sui PERMESSI
 * (Task 6, design `docs/plans/2026-10-22-permessi-progetto-design.md`).
 *
 * Gli utenti hanno ruoli di progetto diversi sugli stessi dati; i test
 * negativi asseriscono anche lo STATO (nessuna riga nuova, colonna
 * invariata), non solo lo status.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

type Headers = { authorization: string };
interface TestUser {
  id: string;
  headers: Headers;
}

let testDb: TestDb;
let app: FastifyInstance;
let projectId: string;
let lead: TestUser;
let dev: TestUser;
let legacy: TestUser;
let viewer: TestUser;
let contrib: TestUser;
let follower: TestUser;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
    embeddingClient: createFakeEmbeddingClient(),
  });
  await seedUsers(app);
  ({ projectId } = await seedRepository(testDb.db));
  lead = await createUserWithPat(app, "lead@example.com");
  dev = await createUserWithPat(app, "dev@example.com");
  legacy = await createUserWithPat(app, "legacy@example.com");
  viewer = await createUserWithPat(app, "viewer@example.com");
  contrib = await createUserWithPat(app, "contrib@example.com");
  follower = await createUserWithPat(app, "follower@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, dev.id, "developer");
  await addMember(app, projectId, legacy.id, "legacy_member");
  await addMember(app, projectId, viewer.id, "viewer");
  await addMember(app, projectId, contrib.id, "contributor");
  // Segue il progetto ma non ne è membro: il follow non dà accesso.
  await testDb.db.insert(projectFollows).values({ userId: follower.id, projectId });
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

function call(
  user: TestUser,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    headers: user.headers,
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function seedBrief(periodStart: string, periodEnd: string): Promise<string> {
  const [row] = await testDb.db
    .insert(projectBriefs)
    .values({
      projectId,
      periodStart,
      periodEnd,
      status: "done",
      summary: "## Dove siamo",
    })
    .returning({ id: projectBriefs.id });
  return row!.id;
}

async function seedDecision(decidedByUserId: string): Promise<string> {
  const [row] = await testDb.db
    .insert(projectDecisions)
    .values({
      projectId,
      source: "manual",
      sourceKey: `manual:${randomBytes(8).toString("hex")}`,
      title: "Formato",
      decision: "CSV",
      decidedByUserId,
    })
    .returning({ id: projectDecisions.id });
  return row!.id;
}

async function seedItem(title: string, requesterId?: string): Promise<string> {
  const [row] = await testDb.db
    .insert(backlogItems)
    .values({ projectId, title, source: "manual" })
    .returning({ id: backlogItems.id });
  if (requesterId) {
    await testDb.db.insert(backlogItemRequesters).values({ itemId: row!.id, userId: requesterId });
  }
  return row!.id;
}

describe("visibilità del progetto: membri sì, follower no", () => {
  it("un follower NON membro riceve 404 su dettaglio, timeline, decisioni, brief e review", async () => {
    const briefId = await seedBrief("2026-08-24", "2026-08-30");
    for (const url of [
      `/api/projects/${projectId}`,
      `/api/projects/${projectId}/timeline`,
      `/api/projects/${projectId}/decisions`,
      `/api/projects/${projectId}/briefs`,
      `/api/projects/${projectId}/reviews`,
      `/api/projects/${projectId}/email-routes`,
      `/api/projects/${projectId}/environments`,
      `/api/projects/${projectId}/widgets`,
      `/api/briefs/${briefId}`,
    ]) {
      const res = await call(follower, "GET", url);
      expect({ url, status: res.statusCode }).toEqual({ url, status: 404 });
      expect((res.json() as { code: string }).code).toBe("not_found");
    }
  });

  it("un membro (Viewer), anche senza seguirlo, li legge: 200", async () => {
    const briefId = await seedBrief("2026-08-17", "2026-08-23");
    for (const url of [
      `/api/projects/${projectId}`,
      `/api/projects/${projectId}/timeline`,
      `/api/projects/${projectId}/decisions`,
      `/api/projects/${projectId}/briefs`,
      `/api/projects/${projectId}/reviews`,
      `/api/projects/${projectId}/email-routes`,
      `/api/projects/${projectId}/environments`,
      `/api/projects/${projectId}/widgets`,
      `/api/briefs/${briefId}`,
    ]) {
      const res = await call(viewer, "GET", url);
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
    }
  });
});

describe("registro decisioni: decisions.record", () => {
  it("senza decisions.record (Viewer): 403 e nessuna riga", async () => {
    const before = await testDb.db.select().from(projectDecisions);
    const res = await call(viewer, "POST", `/api/projects/${projectId}/decisions`, {
      title: "Negata",
      decision: "No",
    });
    expect(res.statusCode).toBe(403);
    expect(await testDb.db.select().from(projectDecisions)).toHaveLength(before.length);
  });

  it("con decisions.record (Developer): 201", async () => {
    const res = await call(dev, "POST", `/api/projects/${projectId}/decisions`, {
      title: "Ammessa",
      decision: "Sì",
    });
    expect(res.statusCode).toBe(201);
  });

  it("la decisione ALTRUI la modifica solo chi ha project.settings.manage", async () => {
    const id = await seedDecision(legacy.id);
    const denied = await call(dev, "PATCH", `/api/projects/${projectId}/decisions/${id}`, {
      title: "Riscritta dal Developer",
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { code: string }).code).toBe("decision_forbidden");
    const [row] = await testDb.db
      .select({ title: projectDecisions.title })
      .from(projectDecisions)
      .where(eq(projectDecisions.id, id));
    expect(row!.title).toBe("Formato");

    const allowed = await call(lead, "PATCH", `/api/projects/${projectId}/decisions/${id}`, {
      title: "Riscritta dal Project Lead",
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("l'autore modifica la propria", async () => {
    const id = await seedDecision(legacy.id);
    const res = await call(legacy, "PATCH", `/api/projects/${projectId}/decisions/${id}`, {
      title: "Corretta dall'autore",
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("impostazioni del progetto: project.settings.manage", () => {
  it("senza (Developer): PATCH, DELETE, email-routes, brief e plugin 403, stato invariato", async () => {
    const patch = await call(dev, "PATCH", `/api/projects/${projectId}`, { name: "Rinominato" });
    expect(patch.statusCode).toBe(403);
    const del = await call(dev, "DELETE", `/api/projects/${projectId}`);
    expect(del.statusCode).toBe(403);
    const routes = await call(dev, "PUT", `/api/projects/${projectId}/email-routes`, {
      routes: [{ kind: "sender_domain", value: "example.com" }],
    });
    expect(routes.statusCode).toBe(403);
    const brief = await call(dev, "POST", `/api/projects/${projectId}/briefs/generate`, {});
    expect(brief.statusCode).toBe(403);
    expect((await call(dev, "GET", `/api/projects/${projectId}/plugins`)).statusCode).toBe(403);
    expect(
      (await call(dev, "PUT", `/api/projects/${projectId}/plugins`, { plugins: [] })).statusCode,
    ).toBe(403);

    const [row] = await testDb.db.select().from(projects).where(eq(projects.id, projectId));
    expect(row).toBeDefined();
    expect(row!.name).not.toBe("Rinominato");
    expect(
      await testDb.db.select().from(projectEmailRoutes).where(eq(projectEmailRoutes.projectId, projectId)),
    ).toHaveLength(0);
    expect(
      await testDb.db.select().from(projectBriefs).where(eq(projectBriefs.status, "queued")),
    ).toHaveLength(0);
  });

  it("con (Project Lead, non admin d'istanza): PATCH e plugin 200", async () => {
    const patch = await call(lead, "PATCH", `/api/projects/${projectId}`, { description: "Del lead" });
    expect(patch.statusCode).toBe(200);
    expect((await call(lead, "GET", `/api/projects/${projectId}/plugins`)).statusCode).toBe(200);
  });

  it("DELETE del progetto: il Project Lead può, un non membro riceve 404", async () => {
    const { projectId: other } = await seedRepository(testDb.db);
    await addMember(app, other, lead.id, "project_lead");
    expect((await call(dev, "DELETE", `/api/projects/${other}`)).statusCode).toBe(404);
    expect((await call(lead, "DELETE", `/api/projects/${other}`)).statusCode).toBe(204);
  });
});

describe("ambienti: environments.manage", () => {
  it("senza (Legacy Member): POST 403 e nessuna riga; con (Developer): 201", async () => {
    const denied = await call(legacy, "POST", `/api/projects/${projectId}/environments`, {
      name: "staging-negato",
      kind: "staging",
    });
    expect(denied.statusCode).toBe(403);
    expect(
      await testDb.db
        .select()
        .from(projectEnvironments)
        .where(eq(projectEnvironments.name, "staging-negato")),
    ).toHaveLength(0);

    const allowed = await call(dev, "POST", `/api/projects/${projectId}/environments`, {
      name: "staging-dev",
      kind: "staging",
    });
    expect(allowed.statusCode).toBe(201);
  });
});

describe("widget: widget.manage", () => {
  const body = {
    name: "Widget",
    enabled: true,
    enabledRepositoryIds: [],
    title: "Supporto",
    welcomeMessage: "Ciao",
    accentColor: "#3366ff",
    language: "it",
    dailyMessageCap: null,
    dailyTicketCap: null,
  };

  it("senza (Legacy Member): POST 403 e nessuna riga; con (Developer): 200", async () => {
    const denied = await call(legacy, "POST", `/api/projects/${projectId}/widgets`, {
      ...body,
      name: "Negato",
    });
    expect(denied.statusCode).toBe(403);
    expect(await testDb.db.select().from(widgets).where(eq(widgets.name, "Negato"))).toHaveLength(0);

    const allowed = await call(dev, "POST", `/api/projects/${projectId}/widgets`, body);
    expect(allowed.statusCode).toBe(200);
  });
});

describe("backlog: backlog.view_all, backlog.create, backlog.edit", () => {
  it("senza backlog.view_all (Contributor): elenco e total solo le voci di cui è richiedente", async () => {
    const own = await seedItem("Voce del contributor", contrib.id);
    const other = await seedItem("Voce altrui", legacy.id);

    const res = await call(contrib, "GET", `/api/backlog?projectId=${projectId}`);
    expect(res.statusCode).toBe(200);
    const page = res.json() as { items: { id: string }[]; total: number };
    const ids = page.items.map((i) => i.id);
    expect(ids).toContain(own);
    expect(ids).not.toContain(other);
    expect(page.total).toBe(page.items.length);

    // Lo stesso elenco a chi ha il permesso: anche la voce altrui.
    const all = await call(viewer, "GET", `/api/backlog?projectId=${projectId}`);
    expect((all.json() as { items: { id: string }[] }).items.map((i) => i.id)).toContain(other);
  });

  it("senza backlog.view_all il dettaglio di una voce altrui è 404, la propria 200", async () => {
    const own = await seedItem("Propria", contrib.id);
    const other = await seedItem("Altrui", legacy.id);
    expect((await call(contrib, "GET", `/api/backlog/${own}`)).statusCode).toBe(200);
    const hidden = await call(contrib, "GET", `/api/backlog/${other}`);
    expect(hidden.statusCode).toBe(404);
    expect((hidden.json() as { code: string }).code).toBe("not_found");
  });

  it("un non membro: dettaglio 404", async () => {
    const item = await seedItem("Del progetto", legacy.id);
    expect((await call(follower, "GET", `/api/backlog/${item}`)).statusCode).toBe(404);
  });

  it("aprire una richiesta: con backlog.create (Contributor) 202, senza (Viewer) 403 e nessun job", async () => {
    const before = await testDb.db.select().from(backlogJobs);
    const denied = await call(viewer, "POST", "/api/backlog", {
      projectId,
      title: "Negata",
      body: "Testo",
    });
    expect(denied.statusCode).toBe(403);
    expect(await testDb.db.select().from(backlogJobs)).toHaveLength(before.length);

    const allowed = await call(contrib, "POST", "/api/backlog", {
      projectId,
      title: "Ammessa",
      body: "Testo",
    });
    expect(allowed.statusCode).toBe(202);
  });

  it("modificare: senza backlog.edit (Viewer) 403 e voce invariata; con (Developer) 200", async () => {
    const item = await seedItem("Da modificare", legacy.id);
    const denied = await call(viewer, "PATCH", `/api/backlog/${item}`, { title: "Cambiato" });
    expect(denied.statusCode).toBe(403);
    const archive = await call(viewer, "PATCH", `/api/backlog/${item}`, { status: "archived" });
    expect(archive.statusCode).toBe(403);
    const convert = await call(viewer, "POST", `/api/backlog/${item}/convert`);
    expect(convert.statusCode).toBe(403);
    const [row] = await testDb.db.select().from(backlogItems).where(eq(backlogItems.id, item));
    expect(row!.title).toBe("Da modificare");
    expect(row!.status).toBe("new");

    const allowed = await call(dev, "PATCH", `/api/backlog/${item}`, { title: "Cambiato" });
    expect(allowed.statusCode).toBe(200);
  });

  it("un Contributor non modifica nemmeno la propria richiesta (backlog.edit)", async () => {
    const own = await seedItem("Mia", contrib.id);
    const res = await call(contrib, "PUT", `/api/backlog/${own}/plan`, { content: "# Piano" });
    expect(res.statusCode).toBe(403);
    const [row] = await testDb.db.select().from(backlogItems).where(eq(backlogItems.id, own));
    expect(row!.implementationPlan).toBeNull();
  });

  it("senza backlog.view_all il `similarTo` verso una voce altrui non esce (lista e dettaglio)", async () => {
    const other = await seedItem("Simile altrui", legacy.id);
    const own = await seedItem("Mia, simile", contrib.id);
    await testDb.db.update(backlogItems).set({ similarToId: other }).where(eq(backlogItems.id, own));

    const detail = await call(contrib, "GET", `/api/backlog/${own}`);
    expect((detail.json() as { similarTo: unknown }).similarTo).toBeNull();
    const list = await call(contrib, "GET", `/api/backlog?projectId=${projectId}`);
    const row = (list.json() as { items: { id: string; similarTo: unknown }[] }).items.find(
      (i) => i.id === own,
    );
    expect(row!.similarTo).toBeNull();

    // Chi ha il permesso la vede.
    const full = await call(viewer, "GET", `/api/backlog/${own}`);
    expect((full.json() as { similarTo: { id: string } | null }).similarTo?.id).toBe(other);
  });

  it("senza tickets.view_all il dettaglio non elenca i ticket collegati altrui", async () => {
    const own = await seedItem("Mia, con ticket", contrib.id);
    const [ticket] = await testDb.db
      .insert(tickets)
      .values({
        projectId,
        number: 9001,
        title: "Ticket altrui",
        type: "task",
        priority: "medium",
        source: "manual",
        requestedByUserId: legacy.id,
      })
      .returning({ id: tickets.id });
    await testDb.db
      .insert(backlogItemTickets)
      .values({ itemId: own, ticketId: ticket!.id, role: "origin" });

    const res = await call(contrib, "GET", `/api/backlog/${own}`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { tickets: unknown[] }).tickets).toEqual([]);
    const full = await call(viewer, "GET", `/api/backlog/${own}`);
    expect((full.json() as { tickets: { id: string }[] }).tickets.map((t) => t.id)).toEqual([
      ticket!.id,
    ]);
  });

  it("fondere verso una voce di un progetto invisibile: 404 target_not_found, nessuna scrittura", async () => {
    const { projectId: hidden } = await seedRepository(testDb.db);
    const [target] = await testDb.db
      .insert(backlogItems)
      .values({ projectId: hidden, title: "Invisibile", source: "manual" })
      .returning({ id: backlogItems.id });
    const item = await seedItem("Da fondere", legacy.id);

    const res = await call(dev, "POST", `/api/backlog/${item}/merge`, { targetId: target!.id });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe("target_not_found");
    const [row] = await testDb.db.select().from(backlogItems).where(eq(backlogItems.id, item));
    expect(row!.status).toBe("new");

    // Da membro di entrambi, lo stesso caso è il 400 di sempre.
    await addMember(app, hidden, dev.id, "developer");
    const cross = await call(dev, "POST", `/api/backlog/${item}/merge`, { targetId: target!.id });
    expect(cross.statusCode).toBe(400);
    expect((cross.json() as { code: string }).code).toBe("cross_project_merge");
  });

  it("lo stato di un job della coda: membro 200, non membro 404", async () => {
    const [job] = await testDb.db
      .insert(backlogJobs)
      .values({ projectId, kind: "intake", payload: { title: "x", body: "y" } })
      .returning({ id: backlogJobs.id });
    expect((await call(contrib, "GET", `/api/backlog/jobs/${job!.id}`)).statusCode).toBe(200);
    expect((await call(follower, "GET", `/api/backlog/jobs/${job!.id}`)).statusCode).toBe(404);
  });
});
