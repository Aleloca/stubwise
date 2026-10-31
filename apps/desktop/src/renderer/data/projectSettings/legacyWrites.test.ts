import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  changelog,
  releases,
  resetApi,
  setLatency,
  setProjectStatuses,
  setStallThresholds,
  support,
} from "../api";
import { recordChange } from "../changelog/index";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { grantInstancePermission } from "../viewer";

// Il Task 3 dell'area 9c: le scritture di progetto che c'erano già (stati,
// soglia «ferma», modo delle PR, pipeline, ambienti, widget) lasciano una
// voce nel registro, con valori stabili. Una scrittura rifiutata non ne
// scrive.

const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const SARA = "p-sara";
const ACQ = "prj-acq";
const AUD = "prj-aud";
const RNC = "prj-rnc";

const as = (id: string) => setSessionPersonId(id);

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => resetApi());

/** Le voci del registro del progetto che questi test scrivono, lette da Laura, più recente prima. */
const KINDS = /^(project\.(statuses|stall_thresholds)_changed|repository\.(pr_mode|release_pipeline)_changed|environment\.|widget\.)/;
async function lauraSees(projectId: string = ACQ) {
  as(LAURA);
  return (await changelog.listProjectChanges(projectId)).filter((e) => KINDS.test(e.kind));
}

function statusInputs() {
  return state.statuses
    .filter((s) => s.projectId === ACQ)
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ id: s.id, name: s.name, family: s.family }));
}

describe("le dieci scritture lasciano una voce", () => {
  it("setProjectStatuses: i nomi prima e dopo", async () => {
    as(ROBERTA);
    const inputs = statusInputs();
    const before = inputs.map((s) => s.name);
    const renamed = inputs.map((s, i) => (i === 0 ? { ...s, name: "Backlogged" } : s));
    await setProjectStatuses(ACQ, renamed, {});
    const [entry] = await lauraSees();
    expect(entry).toMatchObject({ kind: "project.statuses_changed", projectId: ACQ });
    expect(JSON.parse(entry!.before!)).toEqual({ statuses: before });
    expect(JSON.parse(entry!.after!)).toEqual({ statuses: renamed.map((s) => s.name) });
  });

  it("setStallThresholds: i giorni, e un salvataggio identico non scrive", async () => {
    as(ROBERTA);
    const old = state.projectsById.get(ACQ)!.stallThresholds;
    await setStallThresholds(ACQ, { ...old });
    expect(await lauraSees()).toHaveLength(0);
    as(ROBERTA);
    await setStallThresholds(ACQ, { activeDays: old.activeDays + 2, todoDays: old.todoDays });
    const [entry] = await lauraSees();
    expect(entry).toMatchObject({ kind: "project.stall_thresholds_changed", projectId: ACQ });
    expect(JSON.parse(entry!.before!)).toEqual({ activeDays: String(old.activeDays) });
    expect(JSON.parse(entry!.after!)).toEqual({ activeDays: String(old.activeDays + 2) });
  });

  it("setRepoPrMode: l'id del modo", async () => {
    as(ROBERTA);
    const repo = state.repositories.find((r) => r.id === "repo-acq")!;
    const old = repo.colleaguePrs ?? "analyze_and_fix";
    const next = old === "off" ? "analyze_only" : "off";
    await releases.setRepoPrMode(repo.id, next);
    const [entry] = await lauraSees();
    expect(entry).toMatchObject({
      kind: "repository.pr_mode_changed",
      projectId: ACQ,
      object: { type: "repository", id: repo.id, label: repo.name },
    });
    expect(JSON.parse(entry!.before!)).toEqual({ prMode: old });
    expect(JSON.parse(entry!.after!)).toEqual({ prMode: next });
  });

  it("setReleasePipeline: auto o named:<nomi>", async () => {
    as(ROBERTA);
    await releases.setReleasePipeline("repo-acq", { mode: "named", names: ["ci", "e2e"] }, "main");
    const [entry] = await lauraSees();
    expect(entry).toMatchObject({ kind: "repository.release_pipeline_changed", projectId: ACQ });
    expect(JSON.parse(entry!.after!)).toEqual({ pipeline: "named:ci,e2e" });
    as(ROBERTA);
    await releases.setReleasePipeline("repo-acq", { mode: "auto" }, "main");
    const [back] = await lauraSees();
    expect(JSON.parse(back!.before!)).toEqual({ pipeline: "named:ci,e2e" });
    expect(JSON.parse(back!.after!)).toEqual({ pipeline: "auto" });
  });

  it("setReleasePipeline: anche il solo cambio del ramo entra nel registro", async () => {
    as(ROBERTA);
    const repo = state.repositories.find((r) => r.id === "repo-acq")!;
    const pipeline = repo.releasePipeline ?? { mode: "auto" as const };
    const old = repo.releaseBranch ?? "main";
    await releases.setReleasePipeline(repo.id, pipeline, "release/next");
    const [entry] = await lauraSees();
    expect(entry).toMatchObject({ kind: "repository.release_pipeline_changed", projectId: ACQ });
    expect(JSON.parse(entry!.before!)).toEqual({ branch: old });
    expect(JSON.parse(entry!.after!)).toEqual({ branch: "release/next" });
    // Lo stesso salvataggio, di nuovo: niente di nuovo.
    as(ROBERTA);
    await releases.setReleasePipeline(repo.id, pipeline, "release/next");
    expect(await lauraSees()).toHaveLength(1);
  });

  it("setProjectStatuses: anche il solo cambio di famiglia entra nel registro", async () => {
    as(ROBERTA);
    const inputs = statusInputs();
    const target = inputs.find((s) => s.family === "active")!;
    const other = inputs.filter((s) => s.family === "active").length;
    expect(other).toBeGreaterThan(1);
    const changed = inputs.map((s) => (s.id === target.id ? { ...s, family: "todo" as const } : s));
    await setProjectStatuses(ACQ, changed, {});
    const [entry] = await lauraSees();
    expect(entry).toMatchObject({ kind: "project.statuses_changed", projectId: ACQ });
    expect(JSON.parse(entry!.before!)).toEqual({ statusFamilies: [`${target.name}:active`] });
    expect(JSON.parse(entry!.after!)).toEqual({ statusFamilies: [`${target.name}:todo`] });
  });

  it("ambienti: crea, cambia, elimina, col nome com'è", async () => {
    as(ROBERTA);
    const env = await releases.createEnvironment(ACQ, {
      name: "Preview",
      kind: "staging",
      url: null,
      servers: [],
    });
    await releases.updateEnvironment(env.id, { name: "Preview 2" });
    await releases.deleteEnvironment(env.id);
    const entries = (await lauraSees()).slice(0, 3).reverse();
    expect(entries.map((e) => e.kind)).toEqual([
      "environment.created",
      "environment.updated",
      "environment.deleted",
    ]);
    expect(entries.map((e) => e.object.label)).toEqual(["Preview", "Preview 2", "Preview 2"]);
    expect(entries.every((e) => e.projectId === ACQ && e.object.id === env.id)).toBe(true);
    expect(JSON.parse(entries[1]!.before!)).toEqual({ name: "Preview" });
    expect(JSON.parse(entries[1]!.after!)).toEqual({ name: "Preview 2" });
  });

  it("widget: crea, cambia, elimina, col nome com'è", async () => {
    as(ROBERTA);
    const w = await support.createWidget(ACQ, { name: "Help A" });
    await support.updateWidget(w.id, { name: "Help B" });
    await support.deleteWidget(w.id);
    const entries = (await lauraSees()).slice(0, 3).reverse();
    expect(entries.map((e) => e.kind)).toEqual([
      "widget.created",
      "widget.updated",
      "widget.deleted",
    ]);
    expect(entries.map((e) => e.object.label)).toEqual(["Help A", "Help B", "Help B"]);
    expect(entries.every((e) => e.projectId === ACQ && e.object.id === w.id)).toBe(true);
  });
});

describe("una scrittura rifiutata non lascia voci", () => {
  it("per permesso (Sara, Contributor) o per input", async () => {
    const start = state.changelog.length;
    const inputs = statusInputs();
    as(SARA);
    await expect(setProjectStatuses(ACQ, inputs, {})).rejects.toThrow();
    await expect(setStallThresholds(ACQ, { activeDays: 9, todoDays: 9 })).rejects.toThrow();
    await expect(releases.setRepoPrMode("repo-acq", "off")).rejects.toThrow();
    await expect(
      releases.setReleasePipeline("repo-acq", { mode: "auto" }, "main"),
    ).rejects.toThrow();
    await expect(
      releases.createEnvironment(ACQ, { name: "X", kind: "test", url: null, servers: [] }),
    ).rejects.toThrow();
    await expect(releases.updateEnvironment("env-acq-prod", { name: "Y" })).rejects.toThrow();
    await expect(releases.deleteEnvironment("env-acq-prod")).rejects.toThrow();
    await expect(support.createWidget(ACQ, { name: "W" })).rejects.toThrow();
    await expect(support.updateWidget("wdg-acq-portal", { name: "W" })).rejects.toThrow();
    await expect(support.deleteWidget("wdg-acq-portal")).rejects.toThrow();

    as(ROBERTA);
    await expect(setStallThresholds(ACQ, { activeDays: 0, todoDays: 3 })).rejects.toThrow();
    await expect(releases.setRepoPrMode("repo-acq", "bogus" as never)).rejects.toThrow();
    await expect(
      releases.setReleasePipeline("repo-acq", { mode: "named", names: [] }, "main"),
    ).rejects.toThrow();
    await expect(
      releases.createEnvironment(ACQ, { name: " ", kind: "test", url: null, servers: [] }),
    ).rejects.toThrow();
    await expect(support.createWidget(ACQ, { name: "" })).rejects.toThrow();
    await expect(support.updateWidget("wdg-acq-portal", { name: "" })).rejects.toThrow();
    expect(state.changelog.length).toBe(start);
  });
});

describe("R-G5: il registro non mostra il codice né il nome di un progetto che non si vede", () => {
  /** Tutto ciò che una lettura restituisce, come testo. */
  const dump = (x: unknown) => JSON.stringify(x);

  it("Sara non vede nulla di AUD, né il codice né il nome", async () => {
    as(ROBERTA);
    const old = state.projectsById.get(AUD)!.stallThresholds;
    await setStallThresholds(AUD, { activeDays: old.activeDays + 1, todoDays: old.todoDays });
    const aud = state.projectsById.get(AUD)!;
    expect(state.changelog.some((e) => e.kind === "project.stall_thresholds_changed")).toBe(true);
    as(SARA);
    const all = await changelog.listChanges();
    expect(all.some((e) => e.projectId === AUD)).toBe(false);
    for (const word of [aud.code, aud.name]) expect(dump(all)).not.toContain(word);
    await expect(changelog.listProjectChanges(AUD)).rejects.toThrow(/not_found/);
  });

  it("Laura non vede nulla di RNC (archiviato), né il codice né il nome", async () => {
    // RNC è archiviato: nessuna scrittura lo raggiunge, la voce c'è già da prima.
    const rnc = state.projectsById.get(RNC)!;
    recordChange({
      kind: "project.statuses_changed",
      actorId: "p-giulia",
      projectId: RNC,
      object: { type: "project", id: RNC, label: rnc.code },
      before: JSON.stringify({ statuses: [`${rnc.name} todo`] }),
      after: JSON.stringify({ statuses: [`${rnc.name} done`] }),
    });
    // Anche con `changelog.view` d'istanza: il permesso non apre un progetto che non si vede.
    grantInstancePermission(LAURA, "changelog.view");
    as(LAURA);
    const all = await changelog.listChanges();
    expect(all.some((e) => e.projectId === RNC)).toBe(false);
    expect(dump(all)).not.toContain(rnc.code);
    expect(dump(all)).not.toContain(rnc.name);
    await expect(changelog.listProjectChanges(RNC)).rejects.toThrow(/not_found/);
    const choices = await changelog.listChangeFilterChoices();
    expect(dump(choices)).not.toContain(rnc.code);
    expect(dump(choices)).not.toContain(rnc.name);
  });
});
