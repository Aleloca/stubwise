import { randomUUID } from "node:crypto";
import type { RouteOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { claudeChatToolTokens, claudeConversations, docPages, issueChatToolToken, revokeChatToolToken, tickets, projects } from "@stubwise/db";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";
import { CHAT_TOOL_READ_ROUTES, CHAT_TOOL_WRITE_ROUTES } from "./chat-tool-routes.js";

// Il token di UN turno della chat con Claude (fetta 1): i tool di lettura
// chiamano il server COME l'autore. Solo GET, solo un'allowlist chiusa, mai la
// riconferma, solo finché la conversazione è dell'autore e non archiviata.

let t: TestDb;
let app: ReturnType<typeof buildApp>;
let u: Awaited<ReturnType<typeof seedUsers>>;
let author: Awaited<ReturnType<typeof createUserWithSession>>;
let visibleCode: string;
let hiddenCode: string;
let seenRepo: string;
let hiddenRepo: string;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(32) });
  u = await seedUsers(app);
  author = await createUserWithSession(app, "author@example.com");
  const seen = await seedTicket(t.db);
  const hidden = await seedTicket(t.db, { number: 2 });
  await addMember(app, seen.projectId, author.id, "developer");
  const code = async (ticketId: string) => {
    const [row] = await t.db
      .select({ number: tickets.number, key: projects.code })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(eq(tickets.id, ticketId));
    return `${row!.key}-${row!.number}`;
  };
  visibleCode = await code(seen.ticketId);
  hiddenCode = await code(hidden.ticketId);
  seenRepo = seen.repositoryId;
  hiddenRepo = hidden.repositoryId;
  await t.db.insert(docPages).values([
    { repositoryId: seen.repositoryId, kind: "manual", slug: "runbook", title: "Runbook", body: "passi", isManual: true },
    { repositoryId: hidden.repositoryId, kind: "manual", slug: "segreto", title: "Segreto", body: "no", isManual: true },
  ]);
});

afterAll(async () => {
  await app.close();
  await t.stop();
});

async function conversationOf(cookie: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie }, payload: {} });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

const get = (url: string, token: string) =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

describe("il token del turno della chat", () => {
  it("agisce come l'autore: vede ciò che vede lui; un progetto che non vede è 404 anche col token", async () => {
    const sessionId = await conversationOf(author.headers.cookie);
    const token = await issueChatToolToken(t.db, { sessionId, userId: author.id, ttlMs: 60_000 });
    expect((await get(`/api/tasks/by-code/${visibleCode}`, token)).statusCode).toBe(200);
    expect((await get(`/api/tasks/by-code/${hiddenCode}`, token)).statusCode).toBe(404);
    // Fetta 3: le persone, per proporre un assegnatario per nome.
    expect((await get("/api/people", token)).statusCode).toBe(200);
    // Area 10, F2: i reparti, per «avvisa un reparto».
    expect((await get("/api/departments", token)).statusCode).toBe(200);
    // Area 10, F3: le task ferme (la rotta della lista, le soglie dei progetti), senza segnare la conversazione.
    expect((await get("/api/tasks/stalled", token)).statusCode).toBe(200);
    // Il polso NON è fra le letture di Claude (decisione del maintainer: le soglie, non la regola del polso).
    expect((await get("/api/projects/pulse", token)).statusCode).toBe(403);
    const [mark] = await t.db.select({ at: claudeConversations.untrustedReadAt }).from(claudeConversations).where(eq(claudeConversations.sessionId, sessionId));
    expect(mark!.at).toBeNull();
  });

  it("legge una pagina Docs intera (area 5, fetta 1) di un progetto che l'autore vede; l'albero no", async () => {
    const sessionId = await conversationOf(author.headers.cookie);
    const token = await issueChatToolToken(t.db, { sessionId, userId: author.id, ttlMs: 60_000 });
    expect((await get(`/api/repositories/${seenRepo}/docs/pages/runbook`, token)).statusCode).toBe(200);
    expect((await get(`/api/repositories/${hiddenRepo}/docs/pages/segreto`, token)).statusCode).toBe(404);
    expect((await get(`/api/repositories/${seenRepo}/docs/tree`, token)).statusCode).toBe(403);
  });

  it("area 8, F1: legge un rilascio per codice (`read_release`) di un progetto che l'autore vede, 404 a uno nascosto; la lettura segna la conversazione come non fidata", async () => {
    const { releases, claudeConversations } = await import("@stubwise/db");
    const mk = async (projectId: string, repositoryId: string, code: string) =>
      t.db.insert(releases).values({ code, seq: 1, projectId, repositoryId, prNumber: 9, prUrl: "u", title: "Checkout", mergeSha: "f".repeat(40), mergedAt: new Date(), viaStubwise: true });
    const seenP = await t.db.execute<{ project_id: string }>(sql`select project_id from repositories where id = ${seenRepo}`);
    const hiddenP = await t.db.execute<{ project_id: string }>(sql`select project_id from repositories where id = ${hiddenRepo}`);
    await mk(seenP[0]!.project_id, seenRepo, "SEEN-V1");
    await mk(hiddenP[0]!.project_id, hiddenRepo, "HIDE-V1");
    const sessionId = await conversationOf(author.headers.cookie);
    const token = await issueChatToolToken(t.db, { sessionId, userId: author.id, ttlMs: 60_000 });
    expect((await get("/api/releases/HIDE-V1", token)).statusCode).toBe(404);
    const [before] = await t.db.select({ at: claudeConversations.untrustedReadAt }).from(claudeConversations).where(eq(claudeConversations.sessionId, sessionId));
    expect(before!.at).toBeNull();
    expect((await get("/api/releases/SEEN-V1", token)).statusCode).toBe(200);
    const [after] = await t.db.select({ at: claudeConversations.untrustedReadAt }).from(claudeConversations).where(eq(claudeConversations.sessionId, sessionId));
    expect(after!.at).not.toBeNull();
    // Area 10, F1 (review I1): il rilascio registra il suo progetto, come una task.
    const { claudeConversationProjects } = await import("@stubwise/db");
    const read = await t.db.select({ id: claudeConversationProjects.projectId }).from(claudeConversationProjects).where(eq(claudeConversationProjects.sessionId, sessionId));
    expect(read.map((r) => r.id)).toEqual([seenP[0]!.project_id]);
  });

  it("area 10, F1: un'automazione e un server di un progetto che l'autore vede (`read_automation`, `read_server`), 404 a quelli nascosti; l'automazione non segna la conversazione, il server sì (nomi dell'host, M6); entrambi registrano il progetto (I1)", async () => {
    const { automations, automationVersions, servers, projectEnvironments, environmentServers } = await import("@stubwise/db");
    const projectOf = async (repo: string) => (await t.db.execute<{ project_id: string; code: string }>(sql`select r.project_id, p.code from repositories r join projects p on p.id = r.project_id where r.id = ${repo}`))[0]!;
    const seenP = await projectOf(seenRepo);
    const hiddenP = await projectOf(hiddenRepo);
    const flow = { titleTemplate: "x", trigger: { kind: "manual" }, steps: [] };
    for (const [p, n] of [[seenP, 71], [hiddenP, 72]] as const) {
      const [a] = await t.db.insert(automations).values({ code: `${p.code}-A${n}`, seq: n, name: "Auto", description: "", projectId: p.project_id, status: "draft", createdBy: u.adminId }).returning();
      await t.db.insert(automationVersions).values({ automationId: a!.id, n: 1, flow: flow as never, savedBy: u.adminId, rev: 1 });
    }
    const mkServer = async (p: { project_id: string }, repo: string, name: string) => {
      const [srv] = await t.db.insert(servers).values({ name, keyHash: `h-${name}` }).returning();
      const [env] = await t.db.insert(projectEnvironments).values({ projectId: p.project_id, name: "production", kind: "production" }).returning();
      await t.db.insert(environmentServers).values({ environmentId: env!.id, repositoryId: repo, serverId: srv!.id });
      return `SRV-${srv!.number}`;
    };
    const seenServer = await mkServer(seenP, seenRepo, "visto");
    const hiddenServer = await mkServer(hiddenP, hiddenRepo, "nascosto");
    const { claudeConversationProjects } = await import("@stubwise/db");
    const turn = async () => {
      const sessionId = await conversationOf(author.headers.cookie);
      return { sessionId, token: await issueChatToolToken(t.db, { sessionId, userId: author.id, ttlMs: 60_000 }) };
    };
    const markOf = async (sessionId: string) => (await t.db.select({ at: claudeConversations.untrustedReadAt }).from(claudeConversations).where(eq(claudeConversations.sessionId, sessionId)))[0]!.at;
    const projectsOf = async (sessionId: string) => (await t.db.select({ id: claudeConversationProjects.projectId }).from(claudeConversationProjects).where(eq(claudeConversationProjects.sessionId, sessionId))).map((r) => r.id);

    const a = await turn();
    expect((await get(`/api/automations/${seenP.code}-A71`, a.token)).statusCode).toBe(200);
    expect((await get(`/api/automations/${hiddenP.code}-A72`, a.token)).statusCode).toBe(404);
    expect(await markOf(a.sessionId)).toBeNull();
    expect(await projectsOf(a.sessionId)).toEqual([seenP.project_id]);

    const b = await turn();
    expect((await get(`/api/servers/by-code/${hiddenServer}`, b.token)).statusCode).toBe(404);
    expect(await markOf(b.sessionId)).toBeNull();
    expect((await get(`/api/servers/by-code/${seenServer}`, b.token)).statusCode).toBe(200);
    expect(await markOf(b.sessionId)).not.toBeNull();
    expect(await projectsOf(b.sessionId)).toEqual([seenP.project_id]);
  });

  it("area 10, F1: supporto e canali sono contenuto NON fidato — leggerli (200) segna la conversazione; un 404 (nascosto, privato di altri) no", async () => {
    const { widgetConversations, widgetMessages, chatChannels } = await import("@stubwise/db");
    const projectOf = async (repo: string) => (await t.db.execute<{ project_id: string; code: string }>(sql`select r.project_id, p.code from repositories r join projects p on p.id = r.project_id where r.id = ${repo}`))[0]!;
    const seenP = await projectOf(seenRepo);
    const hiddenP = await projectOf(hiddenRepo);
    const conv = async (p: { project_id: string; code: string }) => {
      const [c] = await t.db.insert(widgetConversations).values({ projectId: p.project_id, externalUserId: "v1", externalUserEmail: "cliente@example.com" }).returning();
      await t.db.insert(widgetMessages).values({ conversationId: c!.id, role: "user", content: "Ciao" });
      return `${p.code}-S${c!.number}`;
    };
    const seenConv = await conv(seenP);
    const hiddenConv = await conv(hiddenP);
    const [open] = await t.db.insert(chatChannels).values({ projectId: seenP.project_id, kind: "project", visibility: "open", name: "aperto" }).returning();
    const [secret] = await t.db.insert(chatChannels).values({ projectId: seenP.project_id, kind: "project", visibility: "private", name: "riservato" }).returning();
    const markOf = async (sessionId: string) =>
      (await t.db.select({ at: claudeConversations.untrustedReadAt }).from(claudeConversations).where(eq(claudeConversations.sessionId, sessionId)))[0]!.at;
    const turn = async () => {
      const sessionId = await conversationOf(author.headers.cookie);
      return { sessionId, token: await issueChatToolToken(t.db, { sessionId, userId: author.id, ttlMs: 60_000 }) };
    };

    const a = await turn();
    expect((await get(`/api/support/conversations/by-code/${hiddenConv}`, a.token)).statusCode).toBe(404);
    expect((await get(`/api/chat/channels/${secret!.id}`, a.token)).statusCode).toBe(404);
    expect((await get(`/api/chat/channels/${secret!.id}/messages?limit=30`, a.token)).statusCode).toBe(404);
    expect(await markOf(a.sessionId)).toBeNull();

    const b = await turn();
    expect((await get(`/api/support/conversations/by-code/${seenConv}`, b.token)).statusCode).toBe(200);
    expect(await markOf(b.sessionId)).not.toBeNull();

    const c = await turn();
    expect((await get(`/api/chat/channels/${open!.id}/messages?limit=30`, c.token)).statusCode).toBe(200);
    expect(await markOf(c.sessionId)).not.toBeNull();

    // Review di F1 (I1): supporto e canale registrano il progetto letto, anche
    // dai soli messaggi (la risposta non lo porta).
    const { claudeConversationProjects } = await import("@stubwise/db");
    const projectsOf = async (sessionId: string) => (await t.db.select({ id: claudeConversationProjects.projectId }).from(claudeConversationProjects).where(eq(claudeConversationProjects.sessionId, sessionId))).map((r) => r.id);
    expect(await projectsOf(b.sessionId)).toEqual([seenP.project_id]);
    expect(await projectsOf(c.sessionId)).toEqual([seenP.project_id]);

    // M7: il dettaglio del canale DA SOLO segna anche lui (nome, descrizione, argomento).
    const d = await turn();
    expect((await get(`/api/chat/channels/${open!.id}`, d.token)).statusCode).toBe(200);
    expect(await markOf(d.sessionId)).not.toBeNull();
    expect(await projectsOf(d.sessionId)).toEqual([seenP.project_id]);

    // M7: il canale di un progetto ARCHIVIATO non si legge (come la pagina), e non segna.
    const archived = await seedTicket(t.db, { number: 3 });
    await addMember(app, archived.projectId, author.id, "developer");
    const [old] = await t.db.insert(chatChannels).values({ projectId: archived.projectId, kind: "project", visibility: "open", name: "vecchio" }).returning();
    await t.db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, archived.projectId));
    const e = await turn();
    expect((await get(`/api/chat/channels/${old!.id}/messages?limit=30`, e.token)).statusCode).toBe(404);
    expect(await markOf(e.sessionId)).toBeNull();
  });

  it("area 10, F1, review I2 e I3: posta, calendario, canali privati, DM e automazioni generali SOLO in una conversazione libera privata; letti, la conversazione non si pubblica", async () => {
    const { googleWorkspaces, googleAccounts, emailMessages, calendarEvents, chatChannels, chatChannelMembers, agentSessions, automations, automationVersions } = await import("@stubwise/db");
    const [ws] = await t.db.insert(googleWorkspaces).values({ name: "Acme2", domains: ["acme2.test"], clientId: "c", clientSecretEncrypted: "x" }).returning();
    const [acc] = await t.db.insert(googleAccounts).values({ userId: author.id, workspaceId: ws!.id, email: "autore2@acme2.test", googleSub: "sub-autore2", refreshTokenEncrypted: "x" }).returning();
    await t.db.insert(emailMessages).values({ accountId: acc!.id, gmailMessageId: "m-priv", threadId: "t-priv", fromAddress: "x@cliente.test", subject: "S", receivedAt: new Date(), status: "new" });
    const [ev] = await t.db.insert(calendarEvents).values({ accountId: acc!.id, googleEventId: "e-priv", title: "Demo", startsAt: new Date(), status: "confirmed", fingerprint: "f-priv" }).returning();
    const seenP = (await t.db.execute<{ project_id: string }>(sql`select project_id from repositories where id = ${seenRepo}`))[0]!.project_id;
    const [priv] = await t.db.insert(chatChannels).values({ projectId: seenP, kind: "project", visibility: "private", name: "riservato2" }).returning();
    const [open] = await t.db.insert(chatChannels).values({ projectId: seenP, kind: "project", visibility: "open", name: "aperto2" }).returning();
    await t.db.insert(chatChannelMembers).values({ channelId: priv!.id, userId: author.id });
    const [general] = await t.db.insert(automations).values({ code: "AUT-91", seq: 91, name: "Generale", description: "", projectId: null, status: "draft", createdBy: u.adminId }).returning();
    await t.db.insert(automationVersions).values({ automationId: general!.id, n: 1, flow: { titleTemplate: "x", trigger: { kind: "manual" }, steps: [] } as never, savedBy: u.adminId, rev: 1 });
    const personal = [`/api/me/mail/threads/t-priv?account=${acc!.id}`, `/api/me/calendar/events/${ev!.id}`, `/api/chat/channels/${priv!.id}`, `/api/chat/channels/${priv!.id}/messages?limit=30`, "/api/automations/AUT-91"];
    const privateMark = async (sessionId: string) => (await t.db.select({ at: claudeConversations.privateReadAt }).from(claudeConversations).where(eq(claudeConversations.sessionId, sessionId)))[0]?.at ?? null;
    const publish = (sessionId: string) =>
      app.inject({ method: "POST", url: `/api/claude/conversations/${sessionId}/visibility`, headers: { cookie: author.headers.cookie }, payload: { visibility: "public", confirmedProjectIds: [] } });

    // Una PUBBLICA: tutte e cinque 403, nessun segno; il canale aperto sì.
    const pub = await conversationOf(author.headers.cookie);
    expect((await publish(pub)).statusCode).toBe(200);
    const pubToken = await issueChatToolToken(t.db, { sessionId: pub, userId: author.id, ttlMs: 60_000 });
    for (const url of personal) {
      const res = await get(url, pubToken);
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ code: "chat_tool_private_only" });
    }
    expect((await get(`/api/chat/channels/${open!.id}`, pubToken)).statusCode).toBe(200);
    expect(await privateMark(pub)).toBeNull();

    // Un turno di @Claude nella Chat, come lo crea `chat/claude.ts`: la sua riga in
    // `claude_conversations` è PRIVATA di default, ma la risposta sta in un canale. 403.
    const [mention] = await t.db.insert(agentSessions).values({ ownerKey: `chat_mention:${randomUUID()}`, kind: "chat_mention", title: "" }).returning();
    await t.db.insert(claudeConversations).values({ sessionId: mention!.id, ownerId: author.id, title: "" });
    const mentionToken = await issueChatToolToken(t.db, { sessionId: mention!.id, userId: author.id, ttlMs: 60_000 });
    expect((await get(personal[0]!, mentionToken)).statusCode).toBe(403);
    expect((await get(personal[1]!, mentionToken)).statusCode).toBe(403);

    // Una PRIVATA: la posta si legge, la conversazione è segnata e non si pubblica più.
    const mine = await conversationOf(author.headers.cookie);
    const mineToken = await issueChatToolToken(t.db, { sessionId: mine, userId: author.id, ttlMs: 60_000 });
    expect((await get(personal[0]!, mineToken)).statusCode).toBe(200);
    expect(await privateMark(mine)).not.toBeNull();
    const refused = await publish(mine);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "private_content" });

    // Un canale privato di cui l'autore è membro segna anche lui.
    const ch = await conversationOf(author.headers.cookie);
    const chToken = await issueChatToolToken(t.db, { sessionId: ch, userId: author.id, ttlMs: 60_000 });
    expect((await get(personal[3]!, chToken)).statusCode).toBe(200);
    expect(await privateMark(ch)).not.toBeNull();
  });

  it("area 10, F1: posta e calendario solo di CHI CHIEDE — un full admin che chiede quelli di un altro riceve 404 e niente segno; i suoi, 200 e il segno", async () => {
    const { googleWorkspaces, googleAccounts, emailMessages, calendarEvents } = await import("@stubwise/db");
    const [ws] = await t.db.insert(googleWorkspaces).values({ name: "Acme", domains: ["acme.test"], clientId: "c", clientSecretEncrypted: "x" }).returning();
    const mailboxOf = async (userId: string, tag: string) => {
      const [acc] = await t.db.insert(googleAccounts).values({ userId, workspaceId: ws!.id, email: `${tag}@acme.test`, googleSub: `sub-${tag}`, refreshTokenEncrypted: "x" }).returning();
      const threadId = `t-${tag}`;
      await t.db.insert(emailMessages).values({ accountId: acc!.id, gmailMessageId: `m-${tag}`, threadId, fromAddress: "laura@cliente.test", subject: "Preventivo", receivedAt: new Date("2026-11-19T08:00:00.000Z"), status: "new", textExcerpt: "Ciao" });
      const [ev] = await t.db.insert(calendarEvents).values({ accountId: acc!.id, googleEventId: `e-${tag}`, title: "Demo", startsAt: new Date("2026-11-20T10:00:00.000Z"), status: "confirmed", fingerprint: `f-${tag}` }).returning();
      return { accountId: acc!.id, threadId, eventId: ev!.id };
    };
    const authorBox = await mailboxOf(author.id, "autore");
    const adminBox = await mailboxOf(u.adminId, "admin");
    const markOf = async (sessionId: string) =>
      (await t.db.select({ at: claudeConversations.untrustedReadAt }).from(claudeConversations).where(eq(claudeConversations.sessionId, sessionId)))[0]!.at;
    const turn = async () => {
      const sessionId = await conversationOf(u.adminCookie);
      return { sessionId, token: await issueChatToolToken(t.db, { sessionId, userId: u.adminId, ttlMs: 60_000 }) };
    };

    const a = await turn();
    expect((await get(`/api/me/mail/threads/${authorBox.threadId}?account=${authorBox.accountId}`, a.token)).statusCode).toBe(404);
    expect((await get(`/api/me/mail/threads/${authorBox.threadId}`, a.token)).statusCode).toBe(404);
    expect((await get(`/api/me/calendar/events/${authorBox.eventId}`, a.token)).statusCode).toBe(404);
    expect(await markOf(a.sessionId)).toBeNull();

    const b = await turn();
    expect((await get(`/api/me/mail/threads/${adminBox.threadId}?account=${adminBox.accountId}`, b.token)).statusCode).toBe(200);
    expect(await markOf(b.sessionId)).not.toBeNull();

    const c = await turn();
    expect((await get(`/api/me/calendar/events/${adminBox.eventId}`, c.token)).statusCode).toBe(200);
    expect(await markOf(c.sessionId)).not.toBeNull();
  });

  it("area 10, F3 (S3, D-13 = a): la spesa del mese coi permessi di chi chiede — tutta con usage.view, i propri progetti con project.usage.view, 403 senza; «chi può dirtelo» per tutti", async () => {
    const nobody = await createUserWithSession(app, "nobody-usage@example.com");
    const turnOf = async (userId: string, cookie: string) => {
      const sessionId = await conversationOf(cookie);
      return issueChatToolToken(t.db, { sessionId, userId, ttlMs: 60_000 });
    };
    const summary = "/api/ai-usage/summary?month=true&groupBy=project";
    expect((await get(summary, await turnOf(u.adminId, u.adminCookie))).statusCode).toBe(200);
    expect((await get(summary, await turnOf(author.id, author.headers.cookie))).statusCode).toBe(200);
    const none = await turnOf(nobody.id, nobody.headers.cookie);
    expect((await get(summary, none)).statusCode).toBe(403);
    const who = await get("/api/access/who-can?permission=usage.view", none);
    expect(who.statusCode).toBe(200);
    // R-G5: chi non vede nessuno riceve un elenco vuoto (Claude dice «chi amministra l'istanza»);
    // chi vede il progetto dell'admin lo trova.
    expect((who.json() as { people: unknown[] }).people).toEqual([]);
    const seen = await get("/api/access/who-can?permission=usage.view", await turnOf(author.id, author.headers.cookie));
    expect(seen.statusCode).toBe(200);
  });

  it("solo GET e solo l'allowlist: altre GET, scritture e rotte di credenziale sono rifiutate", async () => {
    const sessionId = await conversationOf(author.headers.cookie);
    const token = await issueChatToolToken(t.db, { sessionId, userId: author.id, ttlMs: 60_000 });
    const auth = { authorization: `Bearer ${token}` };
    for (const url of ["/api/auth/me", "/api/claude/conversations", `/api/agent-sessions/${sessionId}`]) {
      const res = await get(url, token);
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ code: "chat_tool_forbidden" });
    }
    const write = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: auth, payload: {} });
    expect(write.statusCode).toBe(403);
    const pat = await app.inject({ method: "POST", url: "/api/pats", headers: auth, payload: { name: "x" } });
    expect(pat.statusCode).toBe(403);
    const message = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/messages`,
      headers: auth,
      payload: { text: "da Claude" },
    });
    expect(message.statusCode).toBe(403);
  });

  it("revocato, scaduto, conversazione archiviata o eliminata: il token cade (401)", async () => {
    const sessionId = await conversationOf(author.headers.cookie);
    const revoked = await issueChatToolToken(t.db, { sessionId, userId: author.id, ttlMs: 60_000 });
    await revokeChatToolToken(t.db, revoked);
    expect((await get("/api/projects", revoked)).statusCode).toBe(401);

    const expired = await issueChatToolToken(t.db, { sessionId, userId: author.id, ttlMs: -60_000 });
    expect((await get("/api/projects", expired)).statusCode).toBe(401);

    const live = await issueChatToolToken(t.db, { sessionId, userId: author.id, ttlMs: 60_000 });
    expect((await get("/api/projects", live)).statusCode).toBe(200);
    await t.db.update(claudeConversations).set({ archivedAt: new Date() }).where(eq(claudeConversations.sessionId, sessionId));
    expect((await get("/api/projects", live)).statusCode).toBe(401);

    const other = await conversationOf(author.headers.cookie);
    const gone = await issueChatToolToken(t.db, { sessionId: other, userId: author.id, ttlMs: 60_000 });
    await app.inject({ method: "DELETE", url: `/api/claude/conversations/${other}`, headers: { cookie: author.headers.cookie } });
    expect((await get("/api/projects", gone)).statusCode).toBe(401);
    expect(await t.db.select().from(claudeChatToolTokens).where(eq(claudeChatToolTokens.sessionId, other))).toEqual([]);
  });

  it("legato all'autore della conversazione: un token per la sessione di un altro non vale", async () => {
    const adminConversation = await conversationOf(u.adminCookie);
    const token = await issueChatToolToken(t.db, { sessionId: adminConversation, userId: author.id, ttlMs: 60_000 });
    expect((await get("/api/projects", token)).statusCode).toBe(401);
  });
});

describe("l'allowlist delle rotte del token (registro)", () => {
  it("ogni voce è una GET registrata, autenticata, senza riconferma né porta di credenziale", async () => {
    const routes = new Map<string, RouteOptions>();
    const probe = buildApp({
      onRoute: (route) => {
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        for (const m of methods) routes.set(`${m} ${route.url}`, route);
      },
    });
    await probe.ready();
    await probe.close();
    expect(CHAT_TOOL_READ_ROUTES.size).toBeGreaterThan(0);
    // Una sola rotta di scrittura (decisione D2): creare una proposta, nient'altro.
    expect([...CHAT_TOOL_WRITE_ROUTES]).toEqual(["POST /api/claude/conversations/:id/proposals"]);
    for (const key of CHAT_TOOL_WRITE_ROUTES) {
      const route = routes.get(key);
      expect(route, key).toBeDefined();
      expect(route!.config?.reauth, key).toBeUndefined();
      expect(route!.config?.credentialDoor, key).toBeUndefined();
    }
    for (const url of CHAT_TOOL_READ_ROUTES) {
      const route = routes.get(`GET ${url}`);
      expect(route, url).toBeDefined();
      const access = route!.config?.access;
      expect(access?.kind, url).not.toBe("public");
      expect(access?.kind, url).not.toBe("second_factor");
      expect(route!.config?.reauth, url).toBeUndefined();
      expect(route!.config?.credentialDoor, url).toBeUndefined();
    }
  });
});
