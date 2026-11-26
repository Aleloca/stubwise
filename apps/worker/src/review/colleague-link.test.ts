import { repositories, ticketRepositories, tickets } from "@stubwise/db";
import { seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { PullRequestInfo } from "@stubwise/git";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { linkColleaguePr } from "./colleague-link.js";

/**
 * Area 8, F1, S8: senza adozione, la PR di un collega diventa correggibile
 * quando la review la chiude, SOLO se le regole del ramo (verificate dal
 * provider, fail-closed) lo permettono e il repository non è «spento».
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

const okInfo: PullRequestInfo = { state: "open", sourceBranch: "feature/login", targetBranch: "develop", headSha: "a".repeat(40), fromFork: false };

async function setup(opts: { type?: "review" | "bug"; mode?: "analyze_and_fix" | "analyze_only" | "off"; releaseBranch?: string; protectedBranches?: string[] } = {}) {
  const s = await seedTicket(t.db);
  await t.db.update(tickets).set({ type: opts.type ?? "review" }).where(eq(tickets.id, s.ticketId));
  await t.db
    .update(repositories)
    .set({ colleaguePrs: opts.mode ?? "analyze_only", releaseBranch: opts.releaseBranch ?? null, protectedBranches: opts.protectedBranches ?? [] })
    .where(eq(repositories.id, s.repositoryId));
  return s;
}

const link = (s: { ticketId: string; repositoryId: string }, info: PullRequestInfo | Error) =>
  linkColleaguePr(
    {
      db: t.db,
      getPullRequestInfo: async () => {
        if (info instanceof Error) throw info;
        return info;
      },
    },
    { ticketId: s.ticketId, repositoryId: s.repositoryId, prNumber: 7, prUrl: "https://github.com/acme/r/pull/7" },
  );
const rowOf = async (s: { ticketId: string; repositoryId: string }) =>
  (await t.db.select().from(ticketRepositories).where(and(eq(ticketRepositories.ticketId, s.ticketId), eq(ticketRepositories.repositoryId, s.repositoryId))))[0];

describe("linkColleaguePr", () => {
  it("una PR sicura su un repository non spento: la riga c'è, adottata dal SISTEMA (adopted_by null), sul branch del provider", async () => {
    const s = await setup();
    expect(await link(s, okInfo)).toBe("linked");
    expect(await rowOf(s)).toMatchObject({ branch: "feature/login", prNumber: 7, prState: "open", adoptedByUserId: null, adoptionReleasedAt: null });
    expect((await rowOf(s))!.adoptedAt).not.toBeNull();
    // Una seconda review non riscrive niente.
    expect(await link(s, okInfo)).toBe("already");
  });

  const blocked: [string, Partial<PullRequestInfo>, Parameters<typeof setup>[0]?][] = [
    ["fork", { fromFork: true }],
    ["fork", { fromFork: null }],
    ["protected", {}, { protectedBranches: ["feature/*"] }],
    ["default_branch", { sourceBranch: "main" }],
    ["release_branch", { sourceBranch: "release" }, { releaseBranch: "release" }],
    ["target_branch", { sourceBranch: "develop" }],
    ["other_task_branch", { sourceBranch: "stubwise/ticket-99" }],
  ];
  for (const [reason, patch, opts] of blocked) {
    it(`ramo vietato (${reason}${patch.fromFork === null ? ", non verificabile" : ""}): nessuna riga`, async () => {
      const s = await setup(opts);
      expect(await link(s, { ...okInfo, ...patch })).toBe(`blocked:${reason}`);
      expect(await rowOf(s)).toBeUndefined();
    });
  }

  it("il provider non risponde: fail-closed, nessuna riga", async () => {
    const s = await setup();
    expect(await link(s, new Error("503"))).toBe("unverifiable");
    expect(await rowOf(s)).toBeUndefined();
  });

  it("PR chiusa: nessuna riga", async () => {
    const s = await setup();
    expect(await link(s, { ...okInfo, state: "closed" })).toBe("not_open");
    expect(await rowOf(s)).toBeUndefined();
  });

  it("repository «spento»: nessuna riga", async () => {
    const s = await setup({ mode: "off" });
    expect(await link(s, okInfo)).toBe("off");
    expect(await rowOf(s)).toBeUndefined();
  });

  it("un ticket che non è una review (il fix di Stubwise): non si tocca", async () => {
    const s = await setup({ type: "bug" });
    expect(await link(s, okInfo)).toBe("not_review_ticket");
    expect(await rowOf(s)).toBeUndefined();
  });

  it("«Smetti di correggere» (adozione rilasciata) resta: nessuna riadozione", async () => {
    const s = await setup();
    await link(s, okInfo);
    await t.db.update(ticketRepositories).set({ adoptionReleasedAt: new Date() }).where(eq(ticketRepositories.ticketId, s.ticketId));
    expect(await link(s, okInfo)).toBe("released");
    expect((await rowOf(s))!.adoptionReleasedAt).not.toBeNull();
  });
});
