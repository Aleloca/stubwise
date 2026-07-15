import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { resolveReporter, resolveReporterBySlackId } from "./reporter.js";

let testDb: TestDb;
let userId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  const [user] = await testDb.db
    .insert(users)
    .values({
      email: "Reporter@Example.com",
      passwordHash: "x",
      role: "member",
      slackUserId: "Ureporter1",
    })
    .returning({ id: users.id });
  if (!user) throw new Error("insert utente fallita");
  userId = user.id;
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

describe("resolveReporter", () => {
  it("trova l'utente con match case-insensitive sull'email", async () => {
    expect(await resolveReporter(testDb.db, "reporter@example.com")).toBe(userId);
    expect(await resolveReporter(testDb.db, "REPORTER@EXAMPLE.COM")).toBe(userId);
    expect(await resolveReporter(testDb.db, "Reporter@Example.com")).toBe(userId);
  });

  it("ritorna null se nessun utente corrisponde", async () => {
    expect(await resolveReporter(testDb.db, "nessuno@example.com")).toBeNull();
  });

  it("ritorna null se l'email è assente (undefined/null/stringa vuota)", async () => {
    expect(await resolveReporter(testDb.db)).toBeNull();
    expect(await resolveReporter(testDb.db, null)).toBeNull();
    expect(await resolveReporter(testDb.db, "")).toBeNull();
  });
});

describe("resolveReporterBySlackId", () => {
  it("trova l'utente con match esatto sullo Slack user id", async () => {
    expect(await resolveReporterBySlackId(testDb.db, "Ureporter1")).toBe(userId);
  });

  it("ritorna null se nessun utente ha quello Slack id", async () => {
    expect(await resolveReporterBySlackId(testDb.db, "Uignoto")).toBeNull();
  });

  it("ritorna null se lo Slack id è assente (undefined/null/stringa vuota)", async () => {
    expect(await resolveReporterBySlackId(testDb.db)).toBeNull();
    expect(await resolveReporterBySlackId(testDb.db, null)).toBeNull();
    expect(await resolveReporterBySlackId(testDb.db, "")).toBeNull();
  });
});
