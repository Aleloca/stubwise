import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projects, repositories, tickets } from "@stubwise/db";
import { seedRepositoryInProject, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { linkContextsFor } from "./app-link-targets.js";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);
afterAll(async () => {
  await testDb.stop();
});

describe("linkContextsFor: i codici di ADESSO per il link di una card (revisione dei link, I4)", () => {
  it("dalla riga e dagli id dell'evento: progetto, task, repository (anche dal link Docs del web vecchio); un oggetto sparito non dà niente", async () => {
    const { projectId, ticketId } = await seedTicket(testDb.db);
    const repositoryId = await seedRepositoryInProject(testDb.db, projectId);
    const [p] = await testDb.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
    const [t] = await testDb.db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, ticketId));
    const [r] = await testDb.db.select({ slug: repositories.slug }).from(repositories).where(eq(repositories.id, repositoryId));
    const ctx = await linkContextsFor(testDb.db, [
      { id: "a", kind: "job.failed", projectId, ticketId, event: {} },
      // Card di prima: il repository solo nel link del web vecchio, il progetto solo nell'evento.
      { id: "b", kind: "docs.limit_paused", projectId: null, ticketId: null, event: { projectId, docsUrl: `https://x.test/docs/${repositoryId}` } },
      { id: "c", kind: "docs.nightly_attention", projectId, ticketId: null, event: { repositoryId } },
      { id: "d", kind: "project.pulse", projectId: "00000000-0000-4000-8000-000000000000", ticketId: null, event: {} },
    ]);
    expect(ctx.get("a")).toMatchObject({ projectCode: p!.code, taskCode: `${p!.code}-${t!.number}` });
    expect(ctx.get("b")).toMatchObject({ projectCode: p!.code, repositorySlug: r!.slug });
    expect(ctx.get("c")).toMatchObject({ projectCode: p!.code, repositorySlug: r!.slug });
    expect(ctx.get("d")).toEqual({ taskCode: null, projectCode: null, repositorySlug: null, serverCode: null });
  });
});
