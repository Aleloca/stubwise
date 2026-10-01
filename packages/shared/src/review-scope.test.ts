import { describe, expect, it } from "vitest";
import { reviewScopeKey } from "./review-scope.js";

// I casi completi, e l'accordo con l'indice della 0082 su un Postgres vero,
// stanno in `packages/notifications/src/review-account.test.ts`: qui solo la
// forma, per chi importa la funzione dal package dei client.
describe("reviewScopeKey", () => {
  it("su Bitbucket conta il workspace, NULL vale ''", () => {
    expect(reviewScopeKey({ provider: "bitbucket", workspace: "a" })).not.toBe(
      reviewScopeKey({ provider: "bitbucket", workspace: "b" }),
    );
    expect(reviewScopeKey({ provider: "bitbucket", workspace: null })).toBe(
      reviewScopeKey({ provider: "bitbucket", workspace: "" }),
    );
  });

  it("su GitHub il workspace non conta", () => {
    expect(reviewScopeKey({ provider: "github", workspace: "acme" })).toBe(
      reviewScopeKey({ provider: "github", workspace: null }),
    );
  });
});
