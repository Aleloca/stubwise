import { describe, expect, it } from "vitest";
import { isReviewStale, MIN_SHA_PREFIX, sameCommit } from "./release.js";

/**
 * La regola UNA del «è lo stesso commit?» della coda di rilascio (G6): la
 * usano `deployedOn` e `reviewStale`. Bitbucket salva head abbreviate (~12
 * caratteri), GitHub complete: il confronto è per prefisso.
 */
const FULL = "0123456789abcdef0123456789abcdef01234567";

describe("sameCommit", () => {
  it("head abbreviata (Bitbucket) contro completa: lo stesso commit, in entrambi i versi", () => {
    expect(sameCommit(FULL.slice(0, 12), FULL)).toBe(true);
    expect(sameCommit(FULL, FULL.slice(0, 12))).toBe(true);
  });

  it("maiuscole e minuscole non contano", () => {
    expect(sameCommit(FULL.slice(0, 12).toUpperCase(), FULL)).toBe(true);
  });

  it("commit diversi non combaciano", () => {
    expect(sameCommit("fedcba987654", FULL)).toBe(false);
  });

  it(`sotto ${MIN_SHA_PREFIX} caratteri non si afferma niente (una stringa vuota è prefisso di tutto)`, () => {
    expect(sameCommit("", FULL)).toBe(false);
    expect(sameCommit(FULL.slice(0, MIN_SHA_PREFIX - 1), FULL)).toBe(false);
    expect(sameCommit(FULL.slice(0, MIN_SHA_PREFIX), FULL)).toBe(true);
  });

  it("uno dei due assente → false", () => {
    expect(sameCommit(null, FULL)).toBe(false);
    expect(sameCommit(FULL, undefined)).toBe(false);
  });
});

describe("isReviewStale", () => {
  it("head della review abbreviata, uguale per prefisso → false", () => {
    expect(isReviewStale("approve", FULL.slice(0, 12), FULL)).toBe(false);
  });

  it("head diversa → true", () => {
    expect(isReviewStale("request_changes", "fedcba987654", FULL)).toBe(true);
  });

  it("head della review null o vuota → false", () => {
    expect(isReviewStale("approve", null, FULL)).toBe(false);
    expect(isReviewStale("approve", "", FULL)).toBe(false);
  });

  it("head dal vivo non disponibile → false", () => {
    expect(isReviewStale("approve", "fedcba987654", undefined)).toBe(false);
  });

  it("nessun verdetto → false: non c'è niente da dire superato", () => {
    expect(isReviewStale(null, "fedcba987654", FULL)).toBe(false);
  });
});
