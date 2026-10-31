import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changelog, instance, projectSettings, resetApi, setLatency } from "../api";
import { repositoryById } from "../docs/reads";
import { markReauthenticated } from "../auth/reauth";
import { setSessionPersonId } from "../session";
import { state, visibleProjectIds } from "../store";
import { can, grantInstancePermission, revokeProjectPermission, viewerFor } from "../viewer";

// I repository rimasti senza progetto (area 9c, Task 5; confermata dal
// maintainer il 31 ott 2026, domande 2 (b) e 4 (b)), livello dati. Ogni
// prova parte da RNC eliminato da Roberta: `shop-frontend` resta senza
// progetto, su «GitHub Shop» (che nessun altro repository usa). Persone:
// Roberta (full admin), Giulia (ex membro di RNC, Project Lead in MKX),
// Laura (`repos.manage` in ACQ, mai membro di RNC), Sara (senza
// `repos.manage` da nessuna parte).

const ROBERTA = "p-roberta";
const GIULIA = "p-giulia";
const LAURA = "p-laura";
const SARA = "p-sara";
const ACQ = "prj-acq";
const RNC = "prj-rnc";
const REPO = "repo-shop";
const SHOP = "git-github-shop";

const as = (personId: string) => setSessionPersonId(personId);
let seeded = 0;
const entries = (kind?: string) =>
  state.changelog.slice(seeded).filter((e) => !kind || e.kind === kind);
const snapshot = () =>
  JSON.stringify({
    repositories: state.repositories,
    detached: state.detachedRepositories,
    docSpaces: state.docSpaces,
    log: state.changelog.length,
  });
const manages = (personId: string, projectId: string) =>
  can(viewerFor(personId), "repos.manage", projectId);

beforeEach(async () => {
  setLatency(0);
  resetApi();
  as(ROBERTA);
  markReauthenticated(ROBERTA);
  expect(await projectSettings.deleteProject(RNC, { confirmCode: "RNC" })).toEqual({ ok: true });
  seeded = state.changelog.length;
});
afterEach(() => resetApi());

describe("chi li legge, e la provenienza (R-G5)", () => {
  it("Roberta e Giulia leggono da quale progetto viene; Laura no, in nessun campo", async () => {
    for (const person of [ROBERTA, GIULIA]) {
      as(person);
      const [row] = await instance.listDetachedRepositories();
      expect(row).toMatchObject({
        id: REPO,
        name: "shop-frontend",
        fullName: "vetrina-web/shop-frontend",
        gitAccountName: "GitHub Shop",
        gitAccountProvider: "github",
        formerProject: { code: "RNC", name: "Vetrina online Tenuta Ronchi" },
      });
    }
    as(LAURA);
    const rows = await instance.listDetachedRepositories();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.formerProject).toBeNull();
    expect(rows[0]!.canDelete).toBe(false);
    // Ruling (T11): del nome completo solo l'ultimo segmento, il workspace no.
    expect(rows[0]!.fullName).toBe("shop-frontend");
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/rnc|ronchi|vetrina/i);
  });

  it("I3: un workspace che nomina il cliente non esce verso chi non era membro", async () => {
    state.detachedRepositories[0]!.repository.fullName = "tenuta-ronchi/shop";
    for (const person of [ROBERTA, GIULIA]) {
      as(person);
      expect((await instance.listDetachedRepositories())[0]!.fullName).toBe("tenuta-ronchi/shop");
    }
    as(LAURA);
    const rows = await instance.listDetachedRepositories();
    expect(rows[0]!.fullName).toBe("shop");
    expect(JSON.stringify(rows)).not.toMatch(/ronchi/i);
  });

  it("Sara, senza repos.manage, → forbidden", async () => {
    as(SARA);
    await expect(instance.listDetachedRepositories()).rejects.toThrow("forbidden");
  });

  it("i linkTargets di Laura: i suoi progetti attivi con repos.manage; Roberta tutti gli attivi", async () => {
    as(LAURA);
    const [row] = await instance.listDetachedRepositories();
    const expected = [...visibleProjectIds(LAURA)].filter((id) => manages(LAURA, id));
    expect(row!.linkTargets.map((t) => t.projectId).sort()).toEqual(expected.sort());
    expect(row!.linkTargets.map((t) => t.projectId)).toContain(ACQ);
    const codes = row!.linkTargets.map((t) => t.code);
    expect(codes).toEqual([...codes].sort());
    as(ROBERTA);
    const [all] = await instance.listDetachedRepositories();
    expect(all!.canDelete).toBe(true);
    expect(all!.linkTargets).toHaveLength(state.projects.filter((p) => !p.archived).length);
  });
});

describe("collegare un repository senza progetto", () => {
  it("Laura lo collega ad ACQ: entra nei repository e nei Docs, la voce non nomina RNC", async () => {
    as(LAURA);
    expect(await instance.linkRepository(REPO, ACQ)).toEqual({ ok: true });
    const list = (await projectSettings.listProjectRepositories(ACQ))!;
    expect(list.repositories.find((r) => r.id === REPO)).toMatchObject({
      name: "shop-frontend",
      gitAccount: { id: SHOP, name: "GitHub Shop" },
      protectedBranches: ["main"],
      webhook: { state: "not_configured", configuredAt: null },
    });
    expect(state.envFiles.filter((f) => f.repositoryId === REPO)).toEqual([]);
    expect(state.docSpaces.find((s) => s.repositoryId === REPO)).toMatchObject({ projectId: ACQ });
    expect(state.docPages.filter((p) => p.repositoryId === REPO)).toEqual([]);
    expect(repositoryById(REPO)?.projectId).toBe(ACQ);
    expect(await instance.listDetachedRepositories()).toEqual([]);
    const [entry] = entries("repository.linked");
    expect(entry).toMatchObject({
      actorId: LAURA,
      projectId: ACQ,
      object: { type: "repository", id: REPO, label: "shop-frontend" },
    });
    expect(JSON.stringify(entries())).not.toMatch(/rnc|ronchi/i);
    expect(JSON.stringify(entries())).not.toContain(RNC);
  });

  it("i rifiuti, nell'ordine: not_found, forbidden, name_taken; niente cambia, nessuna voce", async () => {
    as(LAURA);
    const sarasOnly = [...visibleProjectIds(SARA)].find((id) => !visibleProjectIds(LAURA).has(id));
    // Un progetto che Laura vede senza `repos.manage`: STW, tolto apposta.
    revokeProjectPermission(LAURA, "prj-stw", "repos.manage" as never);
    const notManaged = [...visibleProjectIds(LAURA)].find((id) => !manages(LAURA, id));
    expect(sarasOnly).toBeDefined();
    expect(notManaged).toBeDefined();
    state.repositories.push({
      ...structuredClone(state.repositories.find((r) => r.id === "repo-acq")!),
      id: "repo-acq-shop",
      name: "Shop-Frontend",
    });
    const before = snapshot();
    expect(await instance.linkRepository("repo-nope", ACQ)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await instance.linkRepository(REPO, RNC)).toEqual({ ok: false, error: "not_found" });
    expect(await instance.linkRepository(REPO, sarasOnly!)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await instance.linkRepository(REPO, notManaged!)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await instance.linkRepository(REPO, ACQ)).toEqual({
      ok: false,
      error: "invalid",
      reason: "name_taken",
    });
    expect(snapshot()).toBe(before);
    expect(entries()).toEqual([]);
  });

  it("verso un progetto archiviato: fuori dai linkTargets, e rifiutato not_found anche al full admin", async () => {
    // ACQ archiviato da Roberta: Laura ne era membro, Roberta è full admin.
    as(ROBERTA);
    expect(await projectSettings.archiveProject(ACQ)).toEqual({ ok: true });
    for (const person of [ROBERTA, LAURA]) {
      as(person);
      const [row] = await instance.listDetachedRepositories();
      expect(row!.linkTargets.map((t) => t.projectId)).not.toContain(ACQ);
      const before = snapshot();
      expect(await instance.linkRepository(REPO, ACQ)).toEqual({ ok: false, error: "not_found" });
      expect(snapshot()).toBe(before);
    }
    expect(entries("repository.linked")).toEqual([]);
  });

  it("un secondo collegamento dello stesso repository → not_found", async () => {
    as(LAURA);
    expect(await instance.linkRepository(REPO, ACQ)).toEqual({ ok: true });
    expect(await instance.linkRepository(REPO, "prj-stw")).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("Roberta lo collega a qualunque progetto attivo, anche dove non è membro", async () => {
    as(ROBERTA);
    const mkx = state.projectsById.get("prj-mkx")!;
    expect(mkx.memberIds).not.toContain(ROBERTA);
    expect(await instance.linkRepository(REPO, mkx.id)).toEqual({ ok: true });
    expect(state.repositories.find((r) => r.id === REPO)!.projectId).toBe(mkx.id);
  });

  it("deleteGitAccount sull'account mentre è senza progetto → in_use, senza codice di progetto", async () => {
    as(ROBERTA);
    expect(await instance.deleteGitAccount(SHOP)).toEqual({
      ok: false,
      error: "in_use",
      usedBy: [{ label: "shop-frontend", projectCode: null }],
      hiddenCount: 0,
    });
    const view = (await instance.listGitAccounts()).find((g) => g.id === SHOP)!;
    expect(view.repositories).toEqual([{ name: "shop-frontend", projectCode: null }]);
  });
});

describe("eliminare un repository senza progetto (+R, full admin)", () => {
  it("Laura → forbidden; senza riconferma → reauth_required; niente cambia, nessuna voce", async () => {
    as(LAURA);
    markReauthenticated(LAURA);
    const before = snapshot();
    expect(await instance.deleteDetachedRepository(REPO)).toEqual({
      ok: false,
      error: "forbidden",
    });
    as(ROBERTA);
    state.reauth.clear();
    expect(await instance.deleteDetachedRepository(REPO)).toEqual({
      ok: false,
      error: "reauth_required",
    });
    expect(snapshot()).toBe(before);
    expect(entries()).toEqual([]);
  });

  it("Roberta lo elimina: sparisce, la voce c'è, l'account git non lo conta più", async () => {
    as(ROBERTA);
    expect(await instance.deleteDetachedRepository(REPO)).toEqual({ ok: true });
    expect(await instance.listDetachedRepositories()).toEqual([]);
    const [entry] = entries("repository.deleted");
    expect(entry).toMatchObject({
      actorId: ROBERTA,
      projectId: null,
      object: { type: "repository", id: REPO, label: "shop-frontend" },
      params: { formerProjectId: RNC },
    });
    expect(await instance.deleteGitAccount(SHOP)).toEqual({ ok: true });
  });

  it("una seconda eliminazione, o un collegamento dopo, → not_found", async () => {
    as(ROBERTA);
    await instance.deleteDetachedRepository(REPO);
    expect(await instance.deleteDetachedRepository(REPO)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await instance.linkRepository(REPO, ACQ)).toEqual({ ok: false, error: "not_found" });
  });

  it("RF 3: la voce letta da chi non era membro non dice RNC; Giulia e Roberta leggono «from RNC»", async () => {
    as(ROBERTA);
    await instance.deleteDetachedRepository(REPO);
    const deletedOf = async () => (await changelog.listChanges({ kind: "repository.deleted" }))[0]!;
    expect((await deletedOf()).params).toEqual({ formerProject: "RNC" });
    grantInstancePermission(GIULIA, "changelog.view");
    as(GIULIA);
    expect((await deletedOf()).params).toEqual({ formerProject: "RNC" });
    grantInstancePermission(LAURA, "changelog.view");
    as(LAURA);
    const laura = await deletedOf();
    expect(laura.params).toEqual({});
    expect(laura.object.label).toBe("shop-frontend");
    const text = JSON.stringify(laura);
    expect(text).not.toMatch(/rnc|ronchi/i);
    expect(text).not.toContain("Ronchi");
    expect(text).not.toContain(RNC);
  });
});
