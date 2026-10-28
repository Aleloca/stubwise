import { describe, expect, it } from "vitest";
import type { PrAnalysis } from "../../data/model";
import { OPEN_PRS } from "../../data/seed/releases/prs";
import type { CorrectionRecord } from "../claude/taskWork";
import {
  correctionsFromRecords,
  isReadyForRelease,
  prState,
  type PrCorrectionInput,
  type PrStateInput,
} from "./prState";

const analysis = (issues: number, status: PrAnalysis["status"] = "done"): PrAnalysis => ({
  sha: "a".repeat(40),
  status,
  summary: "",
  risk: "low",
  issues: Array.from({ length: issues }, (_, i) => ({ title: `p${i}`, file: null })),
  at: "2026-10-28T10:00:00Z",
});

const auto = (state: PrCorrectionInput["state"]): PrCorrectionInput => ({ trigger: "auto", state });

const input = (over: Partial<PrStateInput> = {}): PrStateInput => ({
  origin: "colleague",
  analysis: analysis(1),
  corrections: [],
  cap: 3,
  repoMode: "analyze_and_fix",
  prAnalysisOnly: false,
  branch: "marco/saved-filters",
  baseBranch: "main",
  defaultBranch: "main",
  fromFork: false,
  branchProtected: false,
  ownTaskCode: null,
  ...over,
});

describe("prState — analisi", () => {
  it("senza analisi o in corso → analyzing, niente correzione", () => {
    expect(prState(input({ analysis: null }))).toMatchObject({
      state: "analyzing",
      canAutoCorrect: false,
    });
    expect(prState(input({ analysis: analysis(2, "running") })).state).toBe("analyzing");
  });
  it("senza problemi → clean; dopo un push di Claude → corrected", () => {
    expect(prState(input({ analysis: analysis(0) }))).toMatchObject({
      state: "clean",
      canAutoCorrect: false,
    });
    expect(prState(input({ analysis: analysis(0), corrections: [auto("pushed")] }))).toMatchObject({
      state: "corrected",
      autoRound: 1,
    });
  });
  it("con problemi → issues, e Claude può correggere", () => {
    expect(prState(input())).toEqual({ state: "issues", autoRound: 0, canAutoCorrect: true });
  });
  it("una correzione in volo → correcting", () => {
    expect(prState(input({ corrections: [auto("running")] }))).toMatchObject({
      state: "correcting",
      autoRound: 1,
      canAutoCorrect: false,
    });
  });
});

describe("prState — tetto (correctionCap del progetto)", () => {
  const pushed3 = [auto("pushed"), auto("pushed"), auto("pushed")];
  it("cap 3: dopo tre giri la quarta non parte, anche su un commit nuovo dell'autore", () => {
    // L'analisi è sulla testa nuova (l'autore ha spinto): i giri non si azzerano.
    expect(prState(input({ corrections: pushed3 }))).toEqual({
      state: "capped",
      autoRound: 3,
      canAutoCorrect: false,
    });
  });
  it("cap 2: si ferma alla terza (il numero viene dal progetto)", () => {
    const two = [auto("pushed"), auto("pushed")];
    expect(prState(input({ cap: 2, corrections: two })).state).toBe("capped");
    expect(prState(input({ cap: 3, corrections: two })).state).toBe("issues");
  });
  it("le correzioni chieste da una persona contano nel tetto", () => {
    const mixed: PrCorrectionInput[] = [
      auto("pushed"),
      { trigger: "person", state: "pushed" },
      auto("pushed"),
    ];
    expect(prState(input({ corrections: mixed })).state).toBe("capped");
  });
  it("una scartata (push dell'autore) non conta", () => {
    const withDiscard = [auto("pushed"), auto("discarded"), auto("pushed")];
    expect(prState(input({ corrections: withDiscard }))).toEqual({
      state: "issues",
      autoRound: 2,
      canAutoCorrect: true,
    });
  });
  it("l'ultima scartata → discarded, e si può ripartire", () => {
    expect(prState(input({ corrections: [auto("pushed"), auto("discarded")] }))).toEqual({
      state: "discarded",
      autoRound: 1,
      canAutoCorrect: true,
    });
  });
});

describe("prState — solo analisi e spento", () => {
  it("repository «Solo analisi» → analysis_only", () => {
    expect(prState(input({ repoMode: "analyze_only" }))).toMatchObject({
      state: "analysis_only",
      canAutoCorrect: false,
    });
  });
  it("PR «Solo analisi» → analysis_only, anche con una correzione in volo (si ferma prima del push)", () => {
    expect(prState(input({ prAnalysisOnly: true, corrections: [auto("running")] }))).toMatchObject({
      state: "analysis_only",
      canAutoCorrect: false,
    });
  });
  it("repository «Spento» + PR «Solo analisi» → analysis_off (non si riaccende)", () => {
    expect(prState(input({ repoMode: "off", prAnalysisOnly: true }))).toEqual({
      state: "analysis_off",
      autoRound: 0,
      canAutoCorrect: false,
    });
    expect(prState(input({ repoMode: "off", analysis: null })).state).toBe("analysis_off");
  });
  it("il modo del repository non vale per le PR di Stubwise", () => {
    const own = { origin: "stubwise" as const, branch: "stubwise/STW-3-x", ownTaskCode: "STW-3" };
    expect(prState(input({ ...own, repoMode: "off" })).state).toBe("issues");
    expect(prState(input({ ...own, repoMode: "analyze_only" })).state).toBe("issues");
    // «Solo analisi» sulla singola PR vale per tutte.
    expect(prState(input({ ...own, prAnalysisOnly: true })).state).toBe("analysis_only");
  });
});

describe("prState — rami vietati", () => {
  const cases: [string, Partial<PrStateInput>, string][] = [
    ["fork", { fromFork: true }, "fork"],
    ["protetto", { branchProtected: true }, "protected"],
    [
      "ramo di default",
      { branch: "develop", baseBranch: "release", defaultBranch: "develop" },
      "default_branch",
    ],
    ["ramo di destinazione", { branch: "release", baseBranch: "release" }, "target_branch"],
    [
      "ramo di un'altra task",
      { branch: "stubwise/AUD-7-other", ownTaskCode: "AUD-2" },
      "other_task_branch",
    ],
    [
      "ramo stubwise senza task",
      { branch: "stubwise/AUD-7-other", ownTaskCode: null },
      "other_task_branch",
    ],
  ];
  for (const [name, over, reason] of cases) {
    it(`${name} → not_fixable/${reason}`, () => {
      expect(prState(input(over))).toEqual({
        state: "not_fixable",
        notFixable: reason,
        autoRound: 0,
        canAutoCorrect: false,
      });
    });
  }
  it("il ramo della propria task non è vietato (anche il codice prefisso di un altro)", () => {
    expect(prState(input({ branch: "stubwise/AUD-2-checklist", ownTaskCode: "AUD-2" })).state).toBe(
      "issues",
    );
    expect(prState(input({ branch: "stubwise/AUD-2", ownTaskCode: "AUD-2" })).state).toBe("issues");
    expect(prState(input({ branch: "stubwise/AUD-21-x", ownTaskCode: "AUD-2" })).notFixable).toBe(
      "other_task_branch",
    );
  });
  it("senza problemi il motivo resta, lo stato è clean", () => {
    expect(prState(input({ fromFork: true, analysis: analysis(0) }))).toMatchObject({
      state: "clean",
      notFixable: "fork",
    });
  });
});

describe("correctionsFromRecords — le correzioni di Stubwise dalle sessioni", () => {
  const record = (over: Partial<CorrectionRecord>): CorrectionRecord => ({
    at: "2026-10-28T10:00:00Z",
    pr: "stubwise/guide#58",
    cancelled: false,
    state: "pushed",
    stateAt: "2026-10-28T10:00:00Z",
    ordinal: 1,
    ...over,
  });
  it("solo quelle della PR; le annullate non ci sono; in corso e in pausa sono in volo", () => {
    expect(
      correctionsFromRecords(
        [
          record({}),
          record({ pr: "stubwise/stubwise#411" }),
          record({ cancelled: true }),
          record({ state: "paused" }),
          record({ state: "failed" }),
        ],
        "stubwise/guide#58",
      ),
    ).toEqual([auto("pushed"), auto("running"), auto("stopped")]);
  });
});

describe("isReadyForRelease (R-K4)", () => {
  const guide = OPEN_PRS.find((p) => p.repo === "stubwise/guide" && p.number === 58)!;
  it("stubwise/guide#58: verde e mergeable ma al tetto con problemi → non pronta", () => {
    const state = prState({
      origin: guide.origin,
      analysis: guide.analysis,
      // I tre giri del ciclo automatico, dalle sessioni della task (STW: cap 3).
      corrections: [auto("pushed"), auto("pushed"), auto("pushed")],
      cap: 3,
      repoMode: "analyze_and_fix",
      prAnalysisOnly: guide.analysisOnly !== null,
      branch: guide.branch,
      baseBranch: guide.baseBranch,
      defaultBranch: "main",
      fromFork: guide.fromFork,
      branchProtected: guide.branchProtected,
      ownTaskCode: "STW-3",
    });
    expect(guide.checks).toBe("passing");
    expect(guide.mergeable).toBe(true);
    expect(state.state).toBe("capped");
    expect(isReadyForRelease(guide, state)).toBe(false);
  });
  it("aperta, verde, mergeable e senza problemi aperti → pronta", () => {
    const pr = { state: "open", checks: "passing", mergeable: true } as const;
    expect(isReadyForRelease(pr, { state: "clean" })).toBe(true);
    expect(isReadyForRelease(pr, { state: "corrected" })).toBe(true);
    for (const s of ["analyzing", "issues", "correcting", "capped"] as const) {
      expect(isReadyForRelease(pr, { state: s })).toBe(false);
    }
    expect(isReadyForRelease({ ...pr, checks: "pending" }, { state: "clean" })).toBe(false);
    expect(isReadyForRelease({ ...pr, checks: "unreadable" }, { state: "clean" })).toBe(false);
    expect(isReadyForRelease({ ...pr, mergeable: false }, { state: "clean" })).toBe(false);
    expect(isReadyForRelease({ ...pr, state: "merged" }, { state: "clean" })).toBe(false);
  });
});
