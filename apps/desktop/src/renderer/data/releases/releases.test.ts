import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  failNext,
  getConversation,
  listNotifications,
  releases,
  resetApi,
  setLatency,
  whenIdle,
} from "../api";
import { setSessionPersonId } from "../session";
import { state, storeGeneration } from "../store";
import type { OpenPullRequest } from "../types";
import { grantProjectRole } from "../viewer";

const AUD = "prj-aud";
const STW = "prj-stw";
const as = (personId: string) => setSessionPersonId(personId);
const pr = (id: string): OpenPullRequest => state.openPrs.find((p) => p.id === id)!;
const states = (id: string) => pr(id).corrections.map((c) => c.state);
const tasksCount = () => state.tasks.length;

beforeEach(() => {
  resetApi();
  setLatency(0);
});

afterEach(() => resetApi());

describe("anti-obiettivo 1: api.releases non avvia mai un rilascio", () => {
  it("l'insieme delle funzioni esportate è esattamente quello dello spec", () => {
    const fns = Object.entries(releases)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k)
      .sort();
    expect(fns).toEqual(
      [
        "listOpenPrs",
        "listReleaseQueue",
        "listReleases",
        "getRelease",
        "listEnvironments",
        "listMyReleases",
        "getRepositorySettings",
        "searchReleases",
        "mergePr",
        "setRepoPrMode",
        "setReleasePipeline",
        "setPrAnalysisOnly",
        "requestPrCorrection",
        "fixRelease",
        "explainRelease",
        "createEnvironment",
        "updateEnvironment",
        "deleteEnvironment",
        "simulateRunOutcome",
        "simulateSeenOnServer",
        "simulateAuthorPush",
        "advancePrWork",
      ].sort(),
    );
    for (const name of fns)
      expect(name).not.toMatch(/deploy|rerun|retry|promote|run(pipeline|release)/i);
  });
});

describe("letture", () => {
  it("PR aperte: stessa forma per Stubwise e colleghi, con stato e codice della task", async () => {
    as("p-laura");
    const prs = await releases.listOpenPrs(AUD);
    const byId = new Map(prs.map((p) => [p.id, p]));
    expect(byId.get("opr-aud-244")).toMatchObject({
      taskCode: "AUD-2",
      prState: { state: "clean" },
    });
    expect(byId.get("opr-aud-246")).toMatchObject({ taskCode: null, prState: { state: "issues" } });
    expect(byId.get("opr-aud-248")?.prState.state).toBe("capped");
    expect(byId.get("opr-aud-209")?.prState).toMatchObject({
      state: "not_fixable",
      notFixable: "fork",
    });
    expect(byId.get("opr-aud-admin-31")?.prState.state).toBe("analysis_only");
    for (const p of prs) expect(Object.keys(p).sort()).toEqual(Object.keys(prs[0]!).sort());
  });

  it("la coda: solo le pronte (R-K4, R-K7), con canMerge da release.merge", async () => {
    as("p-laura");
    const queue = await releases.listReleaseQueue(AUD);
    expect(queue.map((q) => q.id)).toEqual(["opr-aud-244"]);
    expect(queue[0]!.canMerge).toBe(true);
    as("p-marco");
    expect((await releases.listReleaseQueue(AUD))[0]!.canMerge).toBe(false);
    // stubwise/guide#58 (al tetto, con problemi) non è pronta.
    as("p-laura");
    const stw = await releases.listReleaseQueue(STW);
    expect(stw.some((q) => q.repo === "stubwise/guide")).toBe(false);
  });

  it("rilasci col loro stato; log solo con repos.view", async () => {
    as("p-laura");
    const v3 = (await releases.getRelease("AUD-V3"))!;
    expect(v3.status.kind).toBe("failed");
    const failed = v3.runs.find((r) => r.status === "failed")!;
    expect(failed.log?.split("\n").length).toBeGreaterThan(5000);
    expect(failed.logHidden).toBe(false);
    // Giulia è Contributor su AUD: vede il rilascio, non il log.
    as("p-giulia");
    const hidden = (await releases.getRelease("AUD-V3"))!;
    expect(hidden.status.kind).toBe("failed");
    const run = hidden.runs.find((r) => r.status === "failed")!;
    expect(run.log).toBeNull();
    expect(run.logHidden).toBe(true);
    const all = await releases.listReleases(STW);
    expect(all.map((r) => [r.code, r.status.kind])).toEqual([
      ["STW-V2", "not_in_production"],
      ["STW-V1", "in_production"],
    ]);
  });

  it("R-G5: un rilascio di un progetto invisibile è come uno che non esiste", async () => {
    as("p-sara"); // non è membro di AUD
    expect(await releases.getRelease("AUD-V3")).toBeNull();
    expect(await releases.getRelease("AUD-V99")).toBeNull();
    expect(await releases.listReleases(AUD)).toEqual([]);
    expect(await releases.listOpenPrs(AUD)).toEqual([]);
    expect(await releases.listEnvironments(AUD)).toEqual({ canManage: false, environments: [] });
    expect(await releases.getRepositorySettings(AUD)).toBeNull();
    expect(await releases.searchReleases("AUD-V")).toEqual([]);
    await expect(releases.fixRelease("AUD-V3")).rejects.toThrow("not_found");
    await expect(releases.explainRelease("AUD-V3")).rejects.toThrow("not_found");
    await expect(releases.fixRelease("AUD-V99")).rejects.toThrow("not_found");
    await expect(releases.advancePrWork("opr-aud-246")).rejects.toThrow("not_found");
  });

  it("⌘K per codice", async () => {
    as("p-laura");
    const found = await releases.searchReleases("aud-v3");
    expect(found).toEqual([
      expect.objectContaining({
        code: "AUD-V3",
        status: "failed",
        route: expect.stringContaining("AUD-V3"),
      }),
    ]);
  });

  it("Home: pronte dove ho release.merge, falliti che mi riguardano", async () => {
    as("p-laura");
    const mine = await releases.listMyReleases();
    expect(mine.ready.map((q) => q.id)).toContain("opr-aud-244");
    expect(mine.failed.map((r) => r.code)).toEqual(["AUD-V3"]);
    as("p-marco"); // Developer: niente merge, e AUD-V3 non lo riguarda
    const marco = await releases.listMyReleases();
    expect(marco.ready).toEqual([]);
    expect(marco.failed).toEqual([]);
  });

  it("impostazioni dei repository e ambienti, coi permessi calcolati qui", async () => {
    as("p-laura");
    const settings = (await releases.getRepositorySettings(AUD))!;
    expect(settings.canManage).toBe(true);
    expect(settings.repositories.map((r) => [r.id, r.colleaguePrs])).toEqual([
      ["repo-aud", "analyze_and_fix"],
      ["repo-aud-admin", "analyze_only"],
      ["repo-aud-scripts", "off"],
    ]);
    as("p-giulia");
    expect((await releases.getRepositorySettings(AUD))!.canManage).toBe(false);
    expect((await releases.listEnvironments(AUD)).canManage).toBe(false);
  });
});

describe("mergePr: ogni esito del web", () => {
  it("Laura rilascia: nuovo AUD-V4, avviso release.merged, run in corso", async () => {
    as("p-laura");
    const before = state.notifications.length;
    const res = await releases.mergePr("opr-aud-244");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.release).toMatchObject({ code: "AUD-V4", mergedById: "p-laura", viaStubwise: true });
    expect(res.release!.status.kind).toBe("running");
    expect(res.release!.runs.map((r) => [r.name, r.status])).toEqual([
      ["CI", "running"],
      ["Deploy to production", "running"],
    ]);
    expect(pr("opr-aud-244").state).toBe("merged");
    expect(state.notifications.slice(before).map((n) => n.kind)).toEqual(["release.merged"]);
    // Un codice non si riusa: il successivo è V5.
    state.openPrs.push({ ...structuredClone(pr("opr-aud-209")), id: "opr-x", fromFork: false });
    pr("opr-x").analysis = { ...pr("opr-x").analysis!, issues: [] };
    const second = await releases.mergePr("opr-x");
    expect(second.ok && second.release?.code).toBe("AUD-V5");
  });

  it("Marco (Developer, senza release.merge) → forbidden e nessun rilascio", async () => {
    as("p-marco");
    const n = state.releases.length;
    expect(await releases.mergePr("opr-aud-244")).toEqual({ ok: false, error: "forbidden" });
    expect(state.releases.length).toBe(n);
    expect(pr("opr-aud-244").state).toBe("open");
  });

  it("not_found, already_closed, checks_failed, checks_unreadable, not_mergeable, merge_forbidden", async () => {
    as("p-sara");
    expect(await releases.mergePr("opr-aud-244")).toEqual({ ok: false, error: "not_found" });
    as("p-laura");
    expect(await releases.mergePr("opr-nope")).toEqual({ ok: false, error: "not_found" });
    const n = state.releases.length;
    const cases: [Partial<OpenPullRequest>, string][] = [
      [{ state: "closed" }, "already_closed"],
      [{ checks: "failing" }, "checks_failed"],
      [{ checks: "unreadable" }, "checks_unreadable"],
      [{ mergeable: false }, "not_mergeable"],
      [{ platformMergeForbidden: true }, "merge_forbidden"],
    ];
    for (const [over, error] of cases) {
      resetApi();
      setLatency(0);
      as("p-laura");
      Object.assign(pr("opr-aud-244"), over);
      expect(await releases.mergePr("opr-aud-244")).toEqual({ ok: false, error });
      expect(state.releases.length).toBe(n);
    }
  });

  it("failNext: niente rilascio", async () => {
    as("p-laura");
    failNext("releases.mergePr");
    const n = state.releases.length;
    await expect(releases.mergePr("opr-aud-244")).rejects.toThrow(/Simulated failure/);
    expect(state.releases.length).toBe(n);
    expect(pr("opr-aud-244").state).toBe("open");
  });
});

describe("Review Focus 2: correzioni sulle PR dei colleghi (livello dati)", () => {
  it("push dell'autore durante la correzione: scartata, non conta, l'analisi riparte", async () => {
    as("p-marco");
    await releases.advancePrWork("opr-aud-246"); // parte la correzione automatica
    expect(states("opr-aud-246")).toEqual(["pushed", "running"]);
    const view = await releases.simulateAuthorPush("opr-aud-246");
    expect(states("opr-aud-246")).toEqual(["pushed", "discarded"]);
    expect(view.prState.state).toBe("analyzing");
    expect(pr("opr-aud-246").analysis).toMatchObject({
      status: "running",
      sha: pr("opr-aud-246").headSha,
    });
    await releases.advancePrWork("opr-aud-246"); // analisi della testa nuova
    const again = await releases.advancePrWork("opr-aud-246"); // la scartata non conta: si riparte
    expect(states("opr-aud-246")).toEqual(["pushed", "discarded", "running"]);
    expect(again.prState.autoRound).toBe(2);
  });

  it("l'autore spinge proprio al momento del push: la correzione si scarta, niente commit", async () => {
    as("p-marco");
    await releases.advancePrWork("opr-aud-246");
    pr("opr-aud-246").headSha = "f".repeat(40); // testa cambiata senza passare dallo scarto
    await releases.advancePrWork("opr-aud-246");
    expect(states("opr-aud-246")).toEqual(["pushed", "discarded"]);
    expect(pr("opr-aud-246").corrections.at(-1)!.commitSha).toBeNull();
    expect(pr("opr-aud-246").headSha).toBe("f".repeat(40));
  });

  it("la correzione arriva: commit sopra, avviso obbligatorio all'autore", async () => {
    as("p-marco");
    const before = state.notifications.length;
    await releases.advancePrWork("opr-aud-246");
    const head = pr("opr-aud-246").headSha;
    await releases.advancePrWork("opr-aud-246");
    const c = pr("opr-aud-246").corrections.at(-1)!;
    expect(c).toMatchObject({ state: "pushed", fromSha: head });
    expect(pr("opr-aud-246").headSha).toBe(c.commitSha);
    const alert = state.notifications.slice(before).find((n) => n.kind === "pr.corrected")!;
    expect(alert.mandatory).toEqual([{ personId: "p-marco", reason: "pr_author" }]);
    expect((await listNotifications()).some((n) => n.id === alert.id)).toBe(true);
  });

  it("al tetto: nessuna automatica, nemmeno dopo commit nuovi dell'autore", async () => {
    as("p-laura");
    expect(states("opr-aud-248")).toEqual(["pushed", "pushed", "pushed"]);
    await releases.advancePrWork("opr-aud-248");
    expect(states("opr-aud-248")).toEqual(["pushed", "pushed", "pushed"]);
    await releases.simulateAuthorPush("opr-aud-248");
    await releases.advancePrWork("opr-aud-248");
    const view = await releases.advancePrWork("opr-aud-248");
    expect(states("opr-aud-248")).toEqual(["pushed", "pushed", "pushed"]);
    expect(view.prState.state).toBe("capped");
  });

  it("oltre il tetto: Marco riceve needs_maintainer e nessuna correzione nasce, Laura la fa partire", async () => {
    as("p-marco");
    expect(
      await releases.requestPrCorrection("opr-aud-248", "Keep the retention at 30 days"),
    ).toEqual({
      ok: false,
      error: "needs_maintainer",
    });
    expect(states("opr-aud-248")).toEqual(["pushed", "pushed", "pushed"]);
    as("p-laura");
    const res = await releases.requestPrCorrection("opr-aud-248", "Keep the retention at 30 days");
    expect(res).toMatchObject({
      ok: true,
      correction: { trigger: "person", byId: "p-laura", state: "running" },
    });
    expect(states("opr-aud-248")).toEqual(["pushed", "pushed", "pushed", "running"]);
  });

  it("le correzioni chieste: prs.adopt sulle PR altrui, l'autore sulla sua", async () => {
    as("p-giulia"); // Contributor: niente prs.adopt
    await expect(releases.requestPrCorrection("opr-aud-246", "x")).rejects.toThrow("forbidden");
    await expect(releases.setPrAnalysisOnly("opr-aud-246", true)).rejects.toThrow("forbidden");
    as("p-marco"); // l'autore
    expect((await releases.requestPrCorrection("opr-aud-246", "Trim the name")).ok).toBe(true);
    expect(await releases.requestPrCorrection("opr-aud-246", "Again")).toEqual({
      ok: false,
      error: "in_flight",
    });
  });

  it("PR di Stubwise: «Chiedi modifiche» apre una sessione della task, sotto lo stesso tetto (R-K2)", async () => {
    as("p-giulia");
    grantProjectRole("p-giulia", AUD, "contributor");
    await expect(releases.requestPrCorrection("opr-aud-244", "x")).rejects.toThrow("forbidden");
    as("p-marco"); // Developer: corrections.request, niente plans.approve
    const res = await releases.requestPrCorrection("opr-aud-244", "Rename the checklist step");
    expect(res).toMatchObject({ ok: true, correction: null });
    const session = state.conversations.find((c) => c.id === (res.ok ? res.sessionId : ""));
    expect(session).toMatchObject({ kind: "task_run", taskId: pr("opr-aud-244").taskId });
    // Una seconda mentre la prima lavora: in volo, nessuna sessione nuova.
    const before = state.conversations.length;
    expect(await releases.requestPrCorrection("opr-aud-244", "Again")).toEqual({
      ok: false,
      error: "in_flight",
    });
    expect(state.conversations.length).toBe(before);
    // guide#58 di STW è al tetto: Marco no, e nessuna sessione nasce.
    expect(await releases.requestPrCorrection("opr-stw-guide-58", "Add Escape")).toEqual({
      ok: false,
      error: "needs_maintainer",
    });
    expect(state.conversations.length).toBe(before);
  });

  it("«Solo analisi» acceso con una correzione in volo: si ferma prima del push", async () => {
    as("p-marco");
    await releases.advancePrWork("opr-aud-246");
    const head = pr("opr-aud-246").headSha;
    const view = await releases.setPrAnalysisOnly("opr-aud-246", true);
    expect(view.prState.state).toBe("analysis_only");
    await releases.advancePrWork("opr-aud-246");
    expect(states("opr-aud-246")).toEqual(["pushed", "stopped"]);
    expect(pr("opr-aud-246").headSha).toBe(head);
    // E non ne parte un'altra.
    await releases.advancePrWork("opr-aud-246");
    expect(states("opr-aud-246")).toEqual(["pushed", "stopped"]);
  });

  it("ramo vietato, per ognuno dei motivi: analizzata, mai corretta", async () => {
    const cases: [Partial<OpenPullRequest>, string][] = [
      [{ fromFork: true }, "fork"],
      [{ branchProtected: true }, "protected"],
      [{ branch: "main", baseBranch: "release" }, "default_branch"],
      [{ branch: "release", baseBranch: "release" }, "target_branch"],
      [{ branch: "stubwise/AUD-7-other" }, "other_task_branch"],
    ];
    for (const [over, reason] of cases) {
      resetApi();
      setLatency(0);
      as("p-laura");
      Object.assign(pr("opr-aud-246"), over);
      const view = await releases.advancePrWork("opr-aud-246");
      expect(view.prState).toMatchObject({ state: "not_fixable", notFixable: reason });
      expect(states("opr-aud-246")).toEqual(["pushed"]);
      expect(await releases.requestPrCorrection("opr-aud-246", "x")).toEqual({
        ok: false,
        error: "not_fixable",
      });
    }
  });

  it("R-K20: col ramo di rilascio spostato su `release`, una PR da `main` resta vietata", async () => {
    as("p-laura");
    await releases.setReleasePipeline("repo-aud", { mode: "auto" }, "release");
    Object.assign(pr("opr-aud-246"), { branch: "main", baseBranch: "release" });
    const view = await releases.advancePrWork("opr-aud-246");
    expect(view.prState).toMatchObject({ state: "not_fixable", notFixable: "default_branch" });
    expect(await releases.requestPrCorrection("opr-aud-246", "x")).toEqual({
      ok: false,
      error: "not_fixable",
    });
    expect(states("opr-aud-246")).toEqual(["pushed"]);
    // E il ramo di rilascio resta vietato anche se non è la base della PR.
    Object.assign(pr("opr-aud-246"), { branch: "release", baseBranch: "develop" });
    const again = await releases.advancePrWork("opr-aud-246");
    expect(again.prState).toMatchObject({ state: "not_fixable", notFixable: "release_branch" });
  });

  it("repository «Spento» con PR «Solo analisi»: non si riaccende", async () => {
    as("p-laura");
    await releases.setRepoPrMode("repo-aud", "off");
    await expect(releases.setPrAnalysisOnly("opr-aud-246", true)).rejects.toThrow(
      "invalid: analysis_off",
    );
    pr("opr-aud-246").analysisOnly = { byId: "p-marco", at: "2026-10-22T10:00:00Z" };
    const view = await releases.advancePrWork("opr-aud-246");
    expect(view.prState.state).toBe("analysis_off");
    expect(states("opr-aud-246")).toEqual(["pushed"]);
    // Spegnere «Solo analisi» resta possibile.
    expect((await releases.setPrAnalysisOnly("opr-aud-246", false)).analysisOnly).toBeNull();
  });

  it("I1: repository messo su «Spento» con una correzione in volo → stopped subito, mai spinta", async () => {
    as("p-laura");
    await releases.advancePrWork("opr-aud-246");
    const head = pr("opr-aud-246").headSha;
    const before = state.notifications.length;
    await releases.setRepoPrMode("repo-aud", "off");
    expect(states("opr-aud-246")).toEqual(["pushed", "stopped"]);
    expect((await releases.advancePrWork("opr-aud-246")).prState).toMatchObject({
      state: "analysis_off",
      autoRound: 1,
    });
    // Riacceso: la fermata non viene spinta e non conta nel tetto.
    await releases.setRepoPrMode("repo-aud", "analyze_and_fix");
    await releases.advancePrWork("opr-aud-246");
    expect(states("opr-aud-246").slice(0, 2)).toEqual(["pushed", "stopped"]);
    expect(pr("opr-aud-246").corrections[1]!.commitSha).toBeNull();
    expect(pr("opr-aud-246").headSha).toBe(head);
    expect(state.notifications.slice(before).some((n) => n.kind === "pr.corrected")).toBe(false);
  });

  it("I1: repository messo su «Solo analisi» con una correzione in volo → stopped", async () => {
    as("p-laura");
    await releases.advancePrWork("opr-aud-246");
    const head = pr("opr-aud-246").headSha;
    await releases.setRepoPrMode("repo-aud", "analyze_only");
    expect(states("opr-aud-246")).toEqual(["pushed", "stopped"]);
    await releases.advancePrWork("opr-aud-246");
    expect(states("opr-aud-246")).toEqual(["pushed", "stopped"]);
    expect(pr("opr-aud-246").headSha).toBe(head);
  });

  it("I1: «Spento» al momento del push (senza passare da setRepoPrMode) → stopped", async () => {
    as("p-laura");
    await releases.advancePrWork("opr-aud-246");
    state.repositories.find((r) => r.id === "repo-aud")!.colleaguePrs = "off";
    await releases.advancePrWork("opr-aud-246");
    expect(states("opr-aud-246")).toEqual(["pushed", "stopped"]);
  });

  it("analisi con problemi: pr.analysis_issues con l'autore obbligatorio; Claude mai scritto", async () => {
    as("p-laura");
    await releases.simulateAuthorPush("opr-aud-246");
    const before = state.notifications.length;
    await releases.advancePrWork("opr-aud-246");
    const issues = state.notifications.slice(before);
    expect(issues.map((n) => n.kind)).toEqual(["pr.analysis_issues"]);
    expect(issues[0]!.mandatory).toEqual([{ personId: "p-marco", reason: "pr_author" }]);
    // Una PR di Claude: nessun obbligatorio scritto per lui (R-K5).
    pr("opr-aud-244").analysis!.issues = [{ title: "x", file: null }];
    await releases.simulateAuthorPush("opr-aud-244");
    const mark = state.notifications.length;
    await releases.advancePrWork("opr-aud-244");
    const claude = state.notifications.slice(mark);
    expect(claude.map((n) => n.kind)).toEqual(["pr.analysis_issues"]);
    expect(claude[0]!.mandatory).toBeUndefined();
  });

  it("impostazioni del repository: repos.manage", async () => {
    as("p-giulia");
    await expect(releases.setRepoPrMode("repo-aud", "off")).rejects.toThrow("forbidden");
    await expect(
      releases.setReleasePipeline("repo-aud", { mode: "named", names: ["CI"] }, "main"),
    ).rejects.toThrow("forbidden");
    as("p-laura");
    await expect(
      releases.setReleasePipeline("repo-aud", { mode: "named", names: [" "] }, "main"),
    ).rejects.toThrow("invalid: names");
    await releases.setReleasePipeline("repo-aud", { mode: "named", names: ["CI"] }, "release");
    const repo = (await releases.getRepositorySettings(AUD))!.repositories[0]!;
    expect(repo).toMatchObject({
      releasePipeline: { mode: "named", names: ["CI"] },
      releaseBranch: "release",
    });
    // Con la pipeline «CI» sola, AUD-V3 (CI riuscita, Deploy fallito) è riuscito.
    expect((await releases.getRelease("AUD-V3"))!.status.kind).toBe("succeeded");
  });
});

describe("Review Focus 3: stato del rilascio ai bordi (livello dati)", () => {
  it("due run, una fallita e una in corso → fallito, con l'avviso obbligatorio a chi ha mergiato", async () => {
    as("p-laura");
    const res = await releases.mergePr("opr-aud-244");
    const code = res.ok ? res.release!.code : "";
    const before = state.notifications.length;
    const [ci, deploy] = (await releases.getRelease(code))!.runs;
    const failed = await releases.simulateRunOutcome(code, ci!.id, "failed");
    expect(failed.status.kind).toBe("failed");
    expect(failed.runs.find((r) => r.id === deploy!.id)!.status).toBe("running");
    const alert = state.notifications.slice(before).find((n) => n.kind === "release.failed")!;
    expect(alert.mandatory).toEqual([{ personId: "p-laura", reason: "merged" }]);
    await expect(releases.simulateRunOutcome(code, ci!.id, "success")).rejects.toThrow(
      "invalid: status",
    );
  });

  it("tutte riuscite → riuscito, con l'avviso", async () => {
    as("p-laura");
    const res = await releases.mergePr("opr-aud-244");
    const code = res.ok ? res.release!.code : "";
    const runs = (await releases.getRelease(code))!.runs;
    await releases.simulateRunOutcome(code, runs[0]!.id, "success");
    const after = await releases.simulateRunOutcome(code, runs[1]!.id, "success");
    expect(after.status.kind).toBe("succeeded");
    expect(state.notifications.at(-1)!.kind).toBe("release.succeeded");
  });

  it("senza pipeline, nessuna run entro la soglia → in corso (merge di adesso)", async () => {
    as("p-laura");
    state.openPrs.push({
      ...structuredClone(pr("opr-aud-244")),
      id: "opr-stw-x",
      projectId: STW,
      repositoryId: "repo-stw",
      repo: "stubwise/stubwise",
      number: 999,
      taskId: null,
    });
    const res = await releases.mergePr("opr-stw-x");
    expect(res.ok && res.release!.runs).toEqual([]);
    expect(res.ok && res.release!.status.kind).toBe("running");
  });

  it("ambiente di produzione senza server → non disponibile; sha corto o maiuscolo", async () => {
    as("p-laura");
    await releases.updateEnvironment("env-stw-prod", { serverCode: null });
    expect((await releases.getRelease("STW-V2"))!.status).toMatchObject({
      kind: "unavailable",
      reason: "no_server",
    });
    const env = state.environments.find((e) => e.id === "env-stw-prod")!;
    env.serverCode = "SRV-2";
    const sha = state.releases.find((r) => r.code === "STW-V2")!.mergeSha;
    env.reportedSha = sha.slice(0, 6);
    expect((await releases.getRelease("STW-V2"))!.status.kind).toBe("not_in_production");
    env.reportedSha = sha.slice(0, 7).toUpperCase();
    expect((await releases.getRelease("STW-V2"))!.status.kind).toBe("in_production");
  });

  it("R-K10: merge senza pipeline e «Simula comparsa sul server» → in produzione subito", async () => {
    as("p-laura");
    state.openPrs.push({
      ...structuredClone(pr("opr-aud-244")),
      id: "opr-stw-y",
      projectId: STW,
      repositoryId: "repo-stw",
      repo: "stubwise/stubwise",
      number: 998,
      taskId: null,
    });
    const res = await releases.mergePr("opr-stw-y");
    const code = res.ok ? res.release!.code : "";
    expect((await releases.getRelease(code))!.status.kind).toBe("running");
    const seen = await releases.simulateSeenOnServer(code);
    expect(seen.status.kind).toBe("in_production");
  });

  it("release.merged e release.succeeded non hanno obbligatori", async () => {
    as("p-laura");
    const before = state.notifications.length;
    const res = await releases.mergePr("opr-aud-244");
    const code = res.ok ? res.release!.code : "";
    for (const run of (await releases.getRelease(code))!.runs) {
      await releases.simulateRunOutcome(code, run.id, "success");
    }
    const added = state.notifications.slice(before);
    expect(added.map((n) => n.kind)).toEqual(["release.merged", "release.succeeded"]);
    for (const n of added) expect(n.mandatory).toBeUndefined();
  });

  it("i rilasci con la stessa ora si ordinano per numero: V10 prima di V9", async () => {
    as("p-laura");
    for (let i = 0; i < 7; i++) {
      const id = `opr-k${i}`;
      state.openPrs.push({ ...structuredClone(pr("opr-aud-244")), id, number: 900 + i });
      expect((await releases.mergePr(id)).ok).toBe(true);
    }
    const codes = (await releases.listReleases(AUD)).map((r) => r.code);
    expect(codes.slice(0, 7)).toEqual([
      "AUD-V10",
      "AUD-V9",
      "AUD-V8",
      "AUD-V7",
      "AUD-V6",
      "AUD-V5",
      "AUD-V4",
    ]);
  });

  it("«Simula comparsa sul server» scrive il commit riportato dall'ambiente di produzione", async () => {
    as("p-laura");
    const v = await releases.simulateSeenOnServer("STW-V2");
    expect(v.status.kind).toBe("in_production");
    const env = state.environments.find((e) => e.id === "env-stw-prod")!;
    expect(env.reportedSha).toBe(state.releases.find((r) => r.code === "STW-V2")!.mergeSha);
  });

  it("doppio clic su «Fai sistemare a Claude»: una sola task", async () => {
    as("p-laura");
    const n = tasksCount();
    const [a, b] = await Promise.all([
      releases.fixRelease("AUD-V3"),
      releases.fixRelease("AUD-V3"),
    ]);
    expect(a.id).toBe(b.id);
    expect(tasksCount()).toBe(n + 1);
    const third = await releases.fixRelease("AUD-V3");
    expect(third.id).toBe(a.id);
    expect(tasksCount()).toBe(n + 1);
  });
});

describe("«Fai sistemare a Claude» e «Chiedi a Claude di spiegarlo»", () => {
  const runsOf = (taskId: string) =>
    state.conversations.filter((c) => c.kind === "task_run" && c.taskId === taskId);

  it("solo tickets.create: la task nasce (bug, releaseRef) senza sessione", async () => {
    as("p-giulia"); // Contributor su AUD
    const n = tasksCount();
    const task = await releases.fixRelease("AUD-V3");
    expect(tasksCount()).toBe(n + 1);
    expect(task).toMatchObject({
      type: "bug",
      releaseRef: { releaseId: "rel8-aud-3" },
      claude: "none",
    });
    expect(task.description).toContain("Run migrations");
    expect(task.description).not.toContain("SQL statement"); // il log resta a chi ha repos.view
    expect(runsOf(task.id)).toEqual([]);
    expect((await releases.getRelease("AUD-V3"))!.fixTask).toMatchObject({
      id: task.id,
      open: true,
    });
  });

  it("con runs.start ma senza plans.approve (Marco): Claude parte e passa dal gate", async () => {
    as("p-marco");
    const task = await releases.fixRelease("AUD-V3");
    const runs = runsOf(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ownerId).toBe("p-marco");
    expect(state.tasksById.get(task.id)!.claude).toBe("working");
    // Il gate si decide quando arriva il piano: Marco non ha plans.approve.
    for (let i = 0; i < 8; i++) {
      await whenIdle(runs[0]!.id);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(runs[0]!.state).toBe("awaiting_approval");
    expect(state.tasksById.get(task.id)!.claude).toBe("awaiting_approval");
  });

  it("collegata «correlata» alla task della PR, se c'era", async () => {
    as("p-laura");
    const v2 = state.releases.find((r) => r.code === "AUD-V2")!;
    v2.runs[1]!.status = "failed";
    const task = await releases.fixRelease("AUD-V2");
    expect(task.links).toEqual([{ kind: "relates", taskId: "t-aud-8" }]);
  });

  it("un rilascio non fallito non si fa sistemare; senza tickets.create è vietato", async () => {
    as("p-laura");
    await expect(releases.fixRelease("AUD-V1")).rejects.toThrow("invalid: status");
    grantProjectRole("p-giulia", AUD, "viewer");
    as("p-giulia");
    await expect(releases.fixRelease("AUD-V3")).rejects.toThrow("forbidden");
  });

  it("spiegalo: una conversazione libera, privata, col rilascio come contesto", async () => {
    as("p-giulia");
    const c = await releases.explainRelease("AUD-V3");
    expect(c).toMatchObject({
      kind: "free",
      ownerId: "p-giulia",
      visibility: "private",
      contextProjectId: AUD,
      context: { kind: "release", releaseId: "rel8-aud-3" },
    });
    as("p-laura");
    expect(await getConversation(c.id)).toBeNull();
  });

  it("spiegalo due volte: la stessa persona riapre la sua conversazione ([R 17]), un'altra ne apre una sua", async () => {
    as("p-giulia");
    const first = await releases.explainRelease("AUD-V3");
    expect(first.reused).toBe(false);
    const again = await releases.explainRelease("AUD-V3");
    expect(again).toMatchObject({ id: first.id, reused: true });
    as("p-laura");
    const laura = await releases.explainRelease("AUD-V3");
    expect(laura.reused).toBe(false);
    expect(laura.id).not.toBe(first.id);
  });

  it("la nota di «Fai sistemare» entra nella descrizione della task ([R 16])", async () => {
    as("p-laura");
    const task = await releases.fixRelease("AUD-V3", "  Backfill the VAT numbers first  ");
    expect(task.description).toMatch(/\n\nBackfill the VAT numbers first$/);
  });
});

describe("ambienti: environments.manage", () => {
  it("crea, modifica, toglie; Giulia no", async () => {
    as("p-giulia");
    await expect(
      releases.createEnvironment(AUD, { name: "QA", kind: "test", url: null, serverCode: null }),
    ).rejects.toThrow("forbidden");
    as("p-laura");
    await expect(
      releases.createEnvironment(AUD, { name: "QA", kind: "test", url: null, serverCode: "srv1" }),
    ).rejects.toThrow("invalid: serverCode");
    const env = await releases.createEnvironment(AUD, {
      name: " QA ",
      kind: "test",
      url: "https://qa.audin.test",
      serverCode: null,
    });
    expect(env).toMatchObject({ name: "QA", projectId: AUD, reportedSha: null });
    await releases.updateEnvironment(env.id, { name: "QA 2" });
    await releases.deleteEnvironment(env.id);
    expect(state.environments.some((e) => e.id === env.id)).toBe(false);
    as("p-sara");
    await expect(releases.deleteEnvironment("env-aud-prod")).rejects.toThrow("not_found");
  });

  it("un solo ambiente di produzione per progetto", async () => {
    as("p-laura");
    const n = state.environments.length;
    await expect(
      releases.createEnvironment(AUD, {
        name: "Prod 2",
        kind: "production",
        url: null,
        serverCode: null,
      }),
    ).rejects.toThrow("invalid: production_exists");
    await expect(
      releases.updateEnvironment("env-aud-staging", { kind: "production" }),
    ).rejects.toThrow("invalid: production_exists");
    expect(state.environments.length).toBe(n);
    // La produzione stessa si può modificare; tolta, se ne crea una nuova.
    await releases.updateEnvironment("env-aud-prod", { kind: "production", name: "Prod" });
    await releases.deleteEnvironment("env-aud-prod");
    await releases.updateEnvironment("env-aud-staging", { kind: "production" });
  });
});

describe("generazioni e ripristino", () => {
  it("un advancePrWork partito prima di resetApi non scrive", async () => {
    setLatency(20);
    as("p-marco");
    const gen = storeGeneration();
    const pending = releases.advancePrWork("opr-aud-246");
    resetApi();
    await expect(pending).rejects.toThrow("reset");
    expect(storeGeneration()).not.toBe(gen);
    expect(states("opr-aud-246")).toEqual(["pushed"]);
  });

  it("resetApi ripulisce PR, rilasci, ambienti e repository", async () => {
    as("p-laura");
    await releases.mergePr("opr-aud-244");
    await releases.setRepoPrMode("repo-aud", "off");
    await releases.deleteEnvironment("env-aud-staging");
    resetApi();
    setLatency(0);
    as("p-laura");
    expect(pr("opr-aud-244").state).toBe("open");
    expect(state.releases.some((r) => r.code === "AUD-V4")).toBe(false);
    expect(state.environments.some((e) => e.id === "env-aud-staging")).toBe(true);
    expect(state.repositories.find((r) => r.id === "repo-aud")!.colleaguePrs).toBe(
      "analyze_and_fix",
    );
    const res = await releases.mergePr("opr-aud-244");
    expect(res.ok && res.release!.code).toBe("AUD-V4");
  });
});
