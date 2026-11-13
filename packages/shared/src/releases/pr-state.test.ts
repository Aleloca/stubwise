import { describe, expect, it } from "vitest";
import {
  colleaguePrBlock,
  isReadyForRelease,
  prStateOf,
  type PrAnalysisLike,
  type PrStateInput,
} from "./pr-state.js";

// Area 8, F1: lo stato di una PR e le regole del ramo vietato, in un posto
// per prototipo, server e worker (era `domain/releases/prState.ts`).

const HEAD = "a".repeat(40);
const analysis = (issues: number, status: PrAnalysisLike["status"] = "done"): PrAnalysisLike => ({
  sha: HEAD,
  status,
  issues: Array.from({ length: issues }, (_, i) => ({ title: `p${i}`, file: null })),
});
const input = (over: Partial<PrStateInput> = {}): PrStateInput => ({
  origin: "colleague",
  headSha: HEAD,
  analysis: analysis(1),
  corrections: [],
  cap: 3,
  repoMode: "analyze_and_fix",
  prAnalysisOnly: false,
  branch: "marco/filters",
  baseBranch: "main",
  defaultBranch: "main",
  releaseBranch: "main",
  fromFork: false,
  branchProtected: false,
  ownTaskCode: null,
  ...over,
});

describe("colleaguePrBlock: il ramo su cui Claude non spinge mai", () => {
  const block = (
    over: Parameters<typeof colleaguePrBlock>[0] extends infer T ? Partial<T> : never,
  ) => colleaguePrBlock({ ...input(), ...over });
  it("fork, protetto (piattaforma o pattern), default, rilascio, target, `stubwise/…` di un'altra task", () => {
    expect(block({ fromFork: true })).toBe("fork");
    expect(block({ branchProtected: true })).toBe("protected");
    expect(block({ branch: "release/1.2", protectedPatterns: ["release/*"] })).toBe("protected");
    expect(block({ branch: "main" })).toBe("default_branch");
    expect(
      block({ branch: "prod", releaseBranch: "prod", defaultBranch: "dev", baseBranch: "dev" }),
    ).toBe("release_branch");
    expect(
      block({
        branch: "develop",
        baseBranch: "develop",
        defaultBranch: "main",
        releaseBranch: "main",
      }),
    ).toBe("target_branch");
    expect(block({ branch: "stubwise/AUD-9" })).toBe("other_task_branch");
  });
  it("il proprio ramo `stubwise/<task>` e un ramo qualunque passano", () => {
    expect(block({ branch: "stubwise/AUD-9", ownTaskCode: "AUD-9" })).toBeNull();
    expect(block({ branch: "stubwise/AUD-9-retry", ownTaskCode: "AUD-9" })).toBeNull();
    expect(block({})).toBeNull();
  });
});

describe("prStateOf", () => {
  it("in analisi, pulita, corretta", () => {
    expect(prStateOf(input({ analysis: null })).state).toBe("analyzing");
    expect(prStateOf(input({ analysis: { ...analysis(0), sha: "b".repeat(40) } })).state).toBe(
      "analyzing",
    );
    expect(prStateOf(input({ analysis: analysis(0) })).state).toBe("clean");
    expect(
      prStateOf(
        input({ analysis: analysis(0), corrections: [{ trigger: "auto", state: "pushed" }] }),
      ).state,
    ).toBe("corrected");
  });
  it("problemi: correggibile, al tetto, scartata, non correggibile, solo analisi, spenta", () => {
    expect(prStateOf(input())).toMatchObject({ state: "issues", canAutoCorrect: true });
    const pushed = { trigger: "auto", state: "pushed" } as const;
    expect(prStateOf(input({ corrections: [pushed, pushed, pushed] }))).toMatchObject({
      state: "capped",
      autoRound: 3,
    });
    expect(prStateOf(input({ corrections: [{ trigger: "auto", state: "discarded" }] })).state).toBe(
      "discarded",
    );
    expect(prStateOf(input({ fromFork: true }))).toMatchObject({
      state: "not_fixable",
      notFixable: "fork",
    });
    expect(prStateOf(input({ prAnalysisOnly: true })).state).toBe("analysis_only");
    expect(prStateOf(input({ repoMode: "analyze_only" })).state).toBe("analysis_only");
    expect(prStateOf(input({ repoMode: "off" })).state).toBe("analysis_off");
  });
  it("una PR di Stubwise ignora la modalità dei colleghi; un'origine `external` è di un collega", () => {
    expect(prStateOf(input({ origin: "stubwise", repoMode: "off" })).state).toBe("issues");
    expect(prStateOf(input({ origin: "external", repoMode: "off" })).state).toBe("analysis_off");
  });
  it("una correzione in volo: correcting, o analysis_only se è acceso", () => {
    const running = [{ trigger: "auto", state: "running" }] as const;
    expect(prStateOf(input({ corrections: [...running] })).state).toBe("correcting");
    expect(prStateOf(input({ corrections: [...running], prAnalysisOnly: true })).state).toBe(
      "analysis_only",
    );
  });
});

describe("isReadyForRelease", () => {
  const pr = (over: Partial<Parameters<typeof isReadyForRelease>[0]> = {}) => ({
    state: "open" as const,
    checks: "passing" as const,
    mergeable: true as boolean | null,
    analysis: analysis(0),
    ...over,
  });
  it("aperta, verde, mergeable, senza problemi aperti", () => {
    expect(isReadyForRelease(pr(), { state: "clean" })).toBe(true);
    expect(isReadyForRelease(pr({ checks: "failing" }), { state: "clean" })).toBe(false);
    expect(isReadyForRelease(pr({ mergeable: false }), { state: "clean" })).toBe(false);
    expect(isReadyForRelease(pr(), { state: "issues" })).toBe(false);
    expect(isReadyForRelease(pr({ analysis: analysis(1) }), { state: "not_fixable" })).toBe(false);
  });
  it("`mergeable` non letto (null) non blocca: lo dice il merge (`not_mergeable`)", () => {
    expect(isReadyForRelease(pr({ mergeable: null }), { state: "clean" })).toBe(true);
  });
});
