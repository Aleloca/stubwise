import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiJobs, projects, repositories, serverProjects, servers, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedBacklogItem, seedRepositoryInProject, seedTicket, startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, partialSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * I rimandi del web vecchio (`/go/…`, `routes/go.ts`): sessione, risoluzione
 * dell'id, 302 al link della nuova app; un oggetto che chi apre non vede, che
 * non c'è o un id non valido portano alla Home con la STESSA risposta (r.1414).
 */
let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let member: { id: string; headers: { cookie: string } };
let outsider: { id: string; headers: { cookie: string } };
let projectId: string;
let code: string;
let ticketId: string;
let ticketNumber: number;

const HOME = "/app/#/home";

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 7).toString("base64") });
  ({ adminCookie } = await seedUsers(app));
  member = await createUserWithSession(app, "membro-go@example.com");
  outsider = await createUserWithSession(app, "estraneo-go@example.com");
  const seeded = await seedTicket(testDb.db);
  ({ projectId, ticketId } = seeded);
  await addMember(app, projectId, member.id, "project_lead");
  const [p] = await testDb.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
  code = p!.code;
  const [t] = await testDb.db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, ticketId));
  ticketNumber = t!.number;
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const go = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });
const locationOf = async (url: string, headers: Record<string, string> = {}) => {
  const res = await go(url, headers);
  expect(res.statusCode, `${url}: ${res.body}`).toBe(302);
  return String(res.headers.location);
};

describe("i rimandi del web vecchio verso la nuova app (/go/…)", () => {
  it("la task: chi la vede arriva sulla task; chi non la vede, un id che non c'è e un id non valido vanno alla Home, con la stessa risposta", async () => {
    expect(await locationOf(`/go/tickets/${ticketId}`, member.headers)).toBe(`/app/#/p/${code}/tasks?task=${code}-${ticketNumber}`);
    const hidden = await go(`/go/tickets/${ticketId}`, outsider.headers);
    const missing = await go(`/go/tickets/${randomUUID()}`, member.headers);
    const invalid = await go("/go/tickets/non-un-id", member.headers);
    for (const res of [hidden, missing, invalid]) {
      expect([res.statusCode, res.headers.location]).toEqual([302, HOME]);
      expect(res.body).toBe("");
    }
    // Il full admin vede ogni progetto.
    expect(await locationOf(`/go/tickets/${ticketId}`, { cookie: adminCookie })).toBe(`/app/#/p/${code}/tasks?task=${code}-${ticketNumber}`);
  });

  it("serve una sessione completa: senza, o a metà login, l'ingresso della nuova app (che chiede il login), mai un 401", async () => {
    expect(await locationOf(`/go/tickets/${ticketId}`)).toBe(HOME);
    const partial = await partialSessionCookie(app, member.id, "second_factor");
    expect(await locationOf(`/go/tickets/${ticketId}`, { cookie: partial })).toBe(HOME);
    expect((await go(`/go/tickets/${ticketId}`)).headers["cache-control"]).toBe("no-store");
  });

  it("il job dell'agente (/agents/job/:jobId) apre la task del suo ticket, anche col solo ?ticketId=", async () => {
    const [job] = await testDb.db.insert(aiJobs).values({ ticketId, status: "failed" }).returning({ id: aiJobs.id });
    const task = `/app/#/p/${code}/tasks?task=${code}-${ticketNumber}`;
    expect(await locationOf(`/go/agents/job/${job!.id}`, member.headers)).toBe(task);
    expect(await locationOf(`/go/agents/job/${randomUUID()}?ticketId=${ticketId}`, member.headers)).toBe(task);
    expect(await locationOf(`/go/agents/job/${job!.id}`, outsider.headers)).toBe(HOME);
  });

  it("le richieste: la voce (/backlog/:id), le richieste del progetto (/backlog?projectId= e /projects/:id/backlog)", async () => {
    const { itemId } = await seedBacklogItem(testDb.db, { projectId });
    expect(await locationOf(`/go/backlog/${itemId}`, member.headers)).toBe(`/app/#/p/${code}/requests?request=${itemId}`);
    expect(await locationOf(`/go/backlog/${itemId}`, outsider.headers)).toBe(HOME);
    expect(await locationOf(`/go/backlog?projectId=${projectId}`, member.headers)).toBe(`/app/#/p/${code}/requests`);
    expect(await locationOf(`/go/projects/${projectId}/backlog`, member.headers)).toBe(`/app/#/p/${code}/requests`);
    expect(await locationOf(`/go/backlog?projectId=${projectId}`, outsider.headers)).toBe(HOME);
  });

  it("il progetto e la roadmap: la panoramica; un progetto invisibile non rivela il suo codice", async () => {
    expect(await locationOf(`/go/projects/${projectId}`, member.headers)).toBe(`/app/#/p/${code}/overview`);
    expect(await locationOf(`/go/projects/${projectId}/roadmap`, member.headers)).toBe(`/app/#/p/${code}/overview`);
    const hidden = await locationOf(`/go/projects/${projectId}`, outsider.headers);
    expect(hidden).toBe(HOME);
    expect(hidden).not.toContain(code);
  });

  it("i Docs: lo spazio del repository per slug; una pagina che non c'è porta allo spazio", async () => {
    const repositoryId = await seedRepositoryInProject(testDb.db, projectId);
    const [repo] = await testDb.db.select({ slug: repositories.slug }).from(repositories).where(eq(repositories.id, repositoryId));
    expect(await locationOf(`/go/docs/${repositoryId}`, member.headers)).toBe(`/app/#/p/${code}/docs/${repo!.slug}`);
    expect(await locationOf(`/go/docs/${repositoryId}/pagina-inventata`, member.headers)).toBe(`/app/#/p/${code}/docs/${repo!.slug}`);
    expect(await locationOf(`/go/docs/${repositoryId}`, outsider.headers)).toBe(HOME);
  });

  it("un server: nel progetto legato che chi apre vede; senza progetto visibile, l'Amministrazione per chi gestisce il monitor, la Home per gli altri", async () => {
    const [server] = await testDb.db
      .insert(servers)
      .values({ name: "web-1", keyHash: randomUUID() })
      .returning({ id: servers.id, number: servers.number });
    await testDb.db.insert(serverProjects).values({ serverId: server!.id, projectId });
    expect(await locationOf(`/go/monitor/servers/${server!.id}`, member.headers)).toBe(`/app/#/p/${code}/servers/SRV-${server!.number}`);
    expect(await locationOf(`/go/monitor/servers/${server!.id}`, outsider.headers)).toBe(HOME);
    const [orphan] = await testDb.db.insert(servers).values({ name: "web-2", keyHash: randomUUID() }).returning({ id: servers.id, number: servers.number });
    expect(await locationOf(`/go/monitor/servers/${orphan!.id}`, { cookie: adminCookie })).toBe(`/app/#/admin/servers/SRV-${orphan!.number}`);
    expect(await locationOf(`/go/monitor/servers/${orphan!.id}`, member.headers)).toBe(HOME);
  });
});
