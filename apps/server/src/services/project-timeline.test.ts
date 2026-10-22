import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prReviews, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import {
  TIMELINE_MAX_DAYS,
  listProjectReviews,
  resolveTimelineWindow,
} from "./project-timeline.js";

/**
 * Il lato HTTP della timeline di progetto (Fase 5): la finestra letta dalla
 * querystring e la lettura delle review (l'ACL è delle rotte, `config.access`).
 *
 * La FUSIONE delle sorgenti non si testa più qui: è salita in
 * `@stubwise/notifications` insieme alla funzione, perché serve anche al brief
 * settimanale del worker (vedi `packages/notifications/src/project-timeline.test.ts`).
 */
let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

/** Istante fisso al centro della finestra di default, per date deterministiche. */
const NOW = new Date("2026-09-06T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

describe("resolveTimelineWindow", () => {
  it("senza parametri: finestra di 28 giorni che finisce adesso", () => {
    const result = resolveTimelineWindow({}, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.window.to.toISOString()).toBe(NOW.toISOString());
    expect(result.window.from.toISOString()).toBe(ago(28).toISOString());
  });

  it("rispetta from/to espliciti", () => {
    const result = resolveTimelineWindow(
      { from: "2026-08-01T00:00:00.000Z", to: "2026-08-10T00:00:00.000Z" },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.window.from.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(result.window.to.toISOString()).toBe("2026-08-10T00:00:00.000Z");
  });

  it("solo `from`: `to` resta adesso", () => {
    const result = resolveTimelineWindow({ from: ago(5).toISOString() }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.window.to.toISOString()).toBe(NOW.toISOString());
  });

  it("solo `to`: `from` è 28 giorni prima di QUEL `to`, non di adesso", () => {
    const result = resolveTimelineWindow({ to: "2026-08-10T00:00:00.000Z" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.window.from.toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });

  it("finestra oltre 180 giorni: rifiutata", () => {
    const result = resolveTimelineWindow(
      { from: ago(TIMELINE_MAX_DAYS + 1).toISOString(), to: NOW.toISOString() },
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: "window_too_large" });
  });

  it("esattamente 180 giorni: ammessa (il limite è incluso)", () => {
    const result = resolveTimelineWindow(
      { from: ago(TIMELINE_MAX_DAYS).toISOString(), to: NOW.toISOString() },
      NOW,
    );
    expect(result.ok).toBe(true);
  });

  it("`from` dopo `to`: intervallo invertito, rifiutato", () => {
    const result = resolveTimelineWindow(
      { from: "2026-08-10T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" },
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_range" });
  });
});


describe("listProjectReviews", () => {
  it("elenca le review del progetto, senza mai l'errore interno", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    await db.insert(prReviews).values({
      repositoryId,
      prNumber: 3,
      prUrl: "https://git.example.com/pr/3",
      prTitle: "Titolo",
      headSha: "sha",
      status: "failed",
      error: "/worker/tmp/segreto: boom",
    });
    const reviews = await listProjectReviews(db, projectId, 50);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ prNumber: 3, verdict: null, prSummary: null });
    expect(JSON.stringify(reviews)).not.toContain("segreto");
  });

  it("non vede le review di un altro progetto", async () => {
    const { repositoryId } = await seedRepository(db);
    const other = await seedRepository(db);
    await db.insert(prReviews).values({
      repositoryId,
      prNumber: 4,
      prUrl: "https://git.example.com/pr/4",
      prTitle: "T",
      headSha: "s",
      status: "completed",
      verdict: "request_changes",
    });
    expect(await listProjectReviews(db, other.projectId, 50)).toEqual([]);
  });
});
