import { describe, expect, it } from "vitest";
import { releaseQueueItemSchema } from "./release.js";

describe("releaseQueueItemSchema", () => {
  const BASE = {
    ticketId: "11111111-1111-4111-8111-111111111111",
    ticketNumber: 42,
    ticketTitle: "Fix the bug",
    repositoryId: "22222222-2222-4222-8222-222222222222",
    repositoryName: "demo-shop",
    projectId: "33333333-3333-4333-8333-333333333333",
    projectName: "Demo Shop",
    branch: "stubwise/ticket-42",
    prUrl: "https://github.com/acme/demo-shop/pull/42",
    prNumber: 42,
    createdAt: "2026-09-10T00:00:00.000Z",
    reviewVerdict: null,
    reviewSummary: null,
    checks: { status: "no_checks", checks: [] },
    testStatus: null,
    risk: null,
    riskReason: null,
    deployedOn: [],
  };

  it("parsa una riga storica (fase pre-8): testStatus/risk NULL, checks no_checks, deployedOn vuoto", () => {
    const parsed = releaseQueueItemSchema.parse(BASE);
    expect(parsed.testStatus).toBeNull();
    expect(parsed.risk).toBeNull();
    expect(parsed.checks.status).toBe("no_checks");
    expect(parsed.deployedOn).toEqual([]);
  });

  it("parsa una riga completa", () => {
    const parsed = releaseQueueItemSchema.parse({
      ...BASE,
      reviewVerdict: "approve",
      reviewSummary: "Cambia solo la formula del totale.",
      checks: { status: "success", checks: [{ name: "build", status: "success" }] },
      testStatus: "passed",
      risk: "low",
      riskReason: "nessun file sensibile, un solo repository",
      deployedOn: ["staging"],
    });
    expect(parsed.risk).toBe("low");
    expect(parsed.deployedOn).toEqual(["staging"]);
  });

  it("prNumber null quando l'URL non è riconosciuto", () => {
    const parsed = releaseQueueItemSchema.parse({ ...BASE, prNumber: null });
    expect(parsed.prNumber).toBeNull();
  });
});
