import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitIdentities, tickets, users } from "@stubwise/db";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commitAuthorEmail, prAuthorMandatory } from "./pr-author.js";

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});
const person = async () => (await t.db.insert(users).values({ email: `p-${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning())[0]!.id;

describe("prAuthorMandatory (area 8, F2, S4)", () => {
  it("PR di Stubwise: l'autore della task del SUO ticket", async () => {
    const { projectId, repositoryId } = await seedRepository(t.db);
    const { ticketId } = await seedTicket(t.db, { projectId, repositoryId, number: 7 });
    const author = await person();
    await t.db.update(tickets).set({ requestedByUserId: author }).where(eq(tickets.id, ticketId));
    expect(await prAuthorMandatory(t.db, { projectId, ticketNumber: 7, branch: "stubwise/ticket-7", headAuthorEmail: null })).toEqual([{ userId: author, reason: "pr_author" }]);
    // Il branch di un ALTRO ticket non è suo.
    expect(await prAuthorMandatory(t.db, { projectId, ticketNumber: 8, branch: "stubwise/ticket-7", headAuthorEmail: null })).toEqual([]);
  });

  it("PR di un collega: l'email del commit di testa collegata a un membro (senza maiuscole); non collegata → nessuno", async () => {
    const { projectId } = await seedRepository(t.db);
    const colleague = await person();
    await t.db.insert(gitIdentities).values({ userId: colleague, email: "marta@acme.it" });
    expect(await prAuthorMandatory(t.db, { projectId, ticketNumber: 3, branch: "feature/x", headAuthorEmail: "Marta@Acme.it" })).toEqual([{ userId: colleague, reason: "pr_author" }]);
    expect(await prAuthorMandatory(t.db, { projectId, ticketNumber: 3, branch: "feature/x", headAuthorEmail: "chi@boh.it" })).toEqual([]);
    expect(await prAuthorMandatory(t.db, { projectId, ticketNumber: 3, branch: "feature/x", headAuthorEmail: null })).toEqual([]);
  });
});

describe("commitAuthorEmail (review F2, 46, 3): l'ultimo commit NON di Stubwise", () => {
  it("review → correzione → review → correzione 2: dopo ogni commit di Stubwise l'autore resta il collega", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-author-"));
    const git = (args: string[], email: string, name: string) =>
      execFileSync("git", ["-c", `user.name=${name}`, "-c", `user.email=${email}`, ...args], { cwd: dir, stdio: "pipe" });
    const commit = (file: string, email: string, name: string) => {
      writeFileSync(join(dir, file), randomUUID());
      git(["add", "-A"], email, name);
      git(["commit", "-m", file], email, name);
    };
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      commit("a.txt", "marta@acme.it", "Marta");
      // La prima review: la testa è del collega.
      expect(await commitAuthorEmail(dir)).toBe("marta@acme.it");
      // La prima correzione di Stubwise.
      commit("b.txt", "ai@stubwise", "Stubwise AI");
      // La seconda review (testa = Stubwise) e la seconda correzione (startSha = commit di Stubwise).
      expect(await commitAuthorEmail(dir)).toBe("marta@acme.it");
      const stubwiseHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
      expect(await commitAuthorEmail(dir, stubwiseHead)).toBe("marta@acme.it");
      commit("c.txt", "ai@stubwise", "Stubwise AI");
      expect(await commitAuthorEmail(dir)).toBe("marta@acme.it");
      // Il collega spinge di nuovo: torna lui l'ultimo.
      commit("d.txt", "luca@acme.it", "Luca");
      expect(await commitAuthorEmail(dir)).toBe("luca@acme.it");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("solo commit di Stubwise: nessun autore (mai Stubwise come pr_author)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-author-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "a.txt"), "x");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["-c", "user.name=Stubwise AI", "-c", "user.email=ai@stubwise", "commit", "-m", "a"], { cwd: dir, stdio: "pipe" });
      expect(await commitAuthorEmail(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
