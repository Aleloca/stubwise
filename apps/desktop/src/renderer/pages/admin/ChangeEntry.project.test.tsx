import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { instance, projectSettings, resetApi, setLatency } from "../../data/api";
import { markReauthenticated } from "../../data/auth/reauth";
import { recordChange } from "../../data/changelog/index";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { grantInstancePermission } from "../../data/viewer";
import i18n, { setLanguage } from "../../i18n";
import { resetReauthForTest } from "../../layout/useReauth";
import { renderRoute } from "../../test/renderRoute";

// Le voci del 9c nel registro (Task 12): la frase dal template del tipo, il
// prima/dopo dai valori stabili tradotti a lettura (Ruling T3), il link alla
// sezione di Progetto → Settings. Scritte con le funzioni vere del livello
// dati, lette in inglese e in italiano. R-G5 / RF 3: chi non era membro di
// RNC non legge nulla di RNC, nemmeno nel DOM.
//
// Persone del seme: Roberta (full admin), Laura (Project Lead in ACQ, mai
// membro di RNC), Giulia (Project Lead in RNC, l'archiviato del seme), Sara
// (Contributor in ACQ). RNC ha `shop-frontend`.

const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const GIULIA = "p-giulia";
const SARA = "p-sara";
const ACQ = "prj-acq";
const RNC = "prj-rnc";

beforeEach(() => {
  setLatency(0);
  resetApi();
  resetReauthForTest();
  window.localStorage.clear();
  state.changelog.splice(0);
});
afterEach(async () => {
  resetApi();
  await i18n.changeLanguage("en");
});

const as = (personId: string) => setSessionPersonId(personId);
const entries = () => [...document.querySelectorAll<HTMLElement>("[data-change-entry]")];
/** Frase e riga del prima/dopo di ogni voce, dalla più recente. */
const lines = () =>
  entries().map((e) => [...e.querySelectorAll("p")].map((p) => p.textContent ?? "").join(" | "));
const entryOf = (kind: string) =>
  document.querySelector<HTMLElement>(`[data-change-entry="${kind}"]`)!;

async function openAdminLog(personId: string) {
  renderRoute("/admin/changelog", personId);
  await screen.findByRole("heading", { level: 1, name: "Change log" });
}

/** Elimina RNC (Roberta): `shop-frontend` resta senza progetto. */
async function deleteRnc() {
  as(ROBERTA);
  markReauthenticated(ROBERTA);
  expect(await projectSettings.deleteProject(RNC, { confirmCode: "RNC" })).toEqual({ ok: true });
}

describe("una voce per gruppo, in inglese e in italiano", () => {
  it("project: interruttore e account AI, col prima e dopo tradotto", async () => {
    as(ROBERTA);
    const settings = await projectSettings.getProjectSettings(ACQ);
    if (!settings) throw new Error("ACQ");
    recordChange({
      kind: "project.switch_changed",
      actorId: ROBERTA,
      projectId: ACQ,
      object: { type: "project", id: ACQ, label: "ACQ" },
      before: "on",
      after: "off",
      params: { switch: "weeklyBrief" },
    });
    expect(
      await projectSettings.setProjectAi(ACQ, { providerId: "prv-backup-max", exclusive: true }),
    ).toEqual({ ok: true });

    await openAdminLog(ROBERTA);
    const expected = {
      en: [
        "Roberta Fontana changed the AI account of ACQ. | Automatic → Backup Max (only this account)",
        "Roberta Fontana turned off the weekly brief in ACQ. | Weekly brief: On → Off",
      ],
      it: [
        "Roberta Fontana ha cambiato l'account AI di ACQ. | Automatico → Backup Max (solo questo account)",
        "Roberta Fontana ha spento il brief settimanale in ACQ. | Brief settimanale: Acceso → Spento",
      ],
    };
    await waitFor(() => expect(lines()).toEqual(expected.en));
    act(() => setLanguage("it"));
    await waitFor(() => expect(lines()).toEqual(expected.it));
  });

  it("project: l'account eliminato si legge «(deleted)», col nome di allora", async () => {
    as(ROBERTA);
    await projectSettings.setProjectAi(ACQ, { providerId: "prv-backup-max", exclusive: false });
    await projectSettings.setProjectAi(ACQ, { providerId: "prv-backup-max", exclusive: true });
    state.instance.providers = state.instance.providers.filter((p) => p.id !== "prv-backup-max");

    await openAdminLog(ROBERTA);
    await waitFor(() =>
      expect(lines()).toEqual([
        "Roberta Fontana changed the AI account of ACQ. | Backup Max (deleted) → Backup Max (deleted, only this account)",
        "Roberta Fontana changed the AI account of ACQ. | Automatic → Backup Max (deleted)",
      ]),
    );
    act(() => setLanguage("it"));
    await waitFor(() =>
      expect(lines()).toEqual([
        "Roberta Fontana ha cambiato l'account AI di ACQ. | Backup Max (eliminato) → Backup Max (eliminato, solo questo account)",
        "Roberta Fontana ha cambiato l'account AI di ACQ. | Automatico → Backup Max (eliminato)",
      ]),
    );
  });

  it("repositories: la variabile d'ambiente (solo il nome) e il campo del repository", async () => {
    as(ROBERTA);
    markReauthenticated(ROBERTA);
    const created = await projectSettings.createEnvFile("repo-acq", {
      environmentId: "env-acq-prod",
      path: ".env",
    });
    if (!created.ok) throw new Error("env file");
    expect(
      await projectSettings.setEnvVar(created.fileId, "DATABASE_URL", "postgres://secret-value"),
    ).toEqual({ ok: true });
    expect(
      await projectSettings.updateRepository("repo-acq", { testCommand: "pnpm test" }),
    ).toEqual({ ok: true });

    await openAdminLog(ROBERTA);
    const expected = {
      en: [
        "Roberta Fontana changed the test command of portale-utenti. | Test command none → pnpm test",
        "Roberta Fontana set DATABASE_URL in .env (Production).",
        "Roberta Fontana created the file .env for Production in portale-utenti.",
      ],
      it: [
        "Roberta Fontana ha cambiato il comando dei test di portale-utenti. | Comando dei test nessuno → pnpm test",
        "Roberta Fontana ha impostato DATABASE_URL in .env (Production).",
        "Roberta Fontana ha creato il file .env per Production in portale-utenti.",
      ],
    };
    await waitFor(() => expect(lines()).toEqual(expected.en));
    expect(document.body.textContent).not.toContain("secret-value");
    act(() => setLanguage("it"));
    await waitFor(() => expect(lines()).toEqual(expected.it));
  });

  it("repositories: il webhook configurato dice prima e dopo; non riuscito, «it failed»", async () => {
    as(ROBERTA);
    await projectSettings.simulateNextWebhookSetup("failed");
    await projectSettings.configureRepositoryWebhook("repo-acq");
    await projectSettings.configureRepositoryWebhook("repo-acq");

    await openAdminLog(ROBERTA);
    await waitFor(() =>
      expect(lines()).toEqual([
        "Roberta Fontana configured the git webhook of portale-utenti. | Failed → Configured",
        "Roberta Fontana tried to configure the git webhook of portale-utenti: it failed. | Not configured → Failed",
      ]),
    );
    act(() => setLanguage("it"));
    await waitFor(() =>
      expect(lines()).toEqual([
        "Roberta Fontana ha configurato il webhook git di portale-utenti. | Non riuscito → Configurato",
        "Roberta Fontana ha provato a configurare il webhook git di portale-utenti: non è riuscito. | Non configurato → Non riuscito",
      ]),
    );
  });

  it("projects: il progetto eliminato, «RNC · …» e 1 repository in nessun progetto, col link ad Amministrazione → Repositories", async () => {
    await deleteRnc();
    await openAdminLog(ROBERTA);
    await waitFor(() =>
      expect(lines()).toEqual([
        "Roberta Fontana deleted the project RNC · Vetrina online Tenuta Ronchi. 1 repository is now in no project.",
      ]),
    );
    const link = within(entryOf("project.deleted")).getByRole("link", {
      name: "1 repository is now in no project",
    });
    expect(link.getAttribute("href")).toBe("/admin/repositories");
    act(() => setLanguage("it"));
    await waitFor(() =>
      expect(lines()).toEqual([
        "Roberta Fontana ha eliminato il progetto RNC · Vetrina online Tenuta Ronchi. 1 repository ora non è in nessun progetto.",
      ]),
    );
  });

  it("projects: a chi non era membro, «a project you couldn't see», senza nulla di RNC", async () => {
    await deleteRnc();
    grantInstancePermission(LAURA, "changelog.view");
    await openAdminLog(LAURA);
    await waitFor(() =>
      expect(lines()).toEqual([
        "Roberta Fontana deleted a project you couldn't see. 1 repository is now in no project.",
      ]),
    );
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/rnc|ronchi/i);
    expect(html).not.toContain("Ronchi");
    expect(html).not.toContain("prj-rnc");
    act(() => setLanguage("it"));
    await waitFor(() =>
      expect(lines()).toEqual([
        "Roberta Fontana ha eliminato un progetto che non vedevi. 1 repository ora non è in nessun progetto.",
      ]),
    );
  });

  it("projects: il repository senza progetto eliminato, «(from RNC)» solo per chi lo sapeva", async () => {
    await deleteRnc();
    expect(await instance.deleteDetachedRepository("repo-shop")).toEqual({ ok: true });
    state.changelog.splice(
      0,
      state.changelog.length,
      ...state.changelog.filter((e) => e.kind === "repository.deleted"),
    );
    const sentence = {
      en: "Roberta Fontana deleted the repository shop-frontend, which was in no project (from RNC).",
      it: "Roberta Fontana ha eliminato il repository shop-frontend, che non era in nessun progetto (da RNC).",
    };

    await openAdminLog(ROBERTA);
    await waitFor(() => expect(lines()).toEqual([sentence.en]));
    expect(within(entryOf("repository.deleted")).queryByRole("link")).toBeNull();
    act(() => setLanguage("it"));
    await waitFor(() => expect(lines()).toEqual([sentence.it]));
  });

  it("projects: Giulia (era membro) legge «(from RNC)», Laura no", async () => {
    await deleteRnc();
    expect(await instance.deleteDetachedRepository("repo-shop")).toEqual({ ok: true });
    grantInstancePermission(GIULIA, "changelog.view");
    grantInstancePermission(LAURA, "changelog.view");

    const giulia = await openRepositoryDeleted(GIULIA);
    expect(giulia).toBe(
      "Roberta Fontana deleted the repository shop-frontend, which was in no project (from RNC).",
    );
  });

  it("projects: Laura (non era membro) legge la frase senza la parentesi", async () => {
    await deleteRnc();
    expect(await instance.deleteDetachedRepository("repo-shop")).toEqual({ ok: true });
    grantInstancePermission(LAURA, "changelog.view");
    expect(await openRepositoryDeleted(LAURA)).toBe(
      "Roberta Fontana deleted the repository shop-frontend, which was in no project.",
    );
    expect(document.body.innerHTML).not.toMatch(/rnc|ronchi/i);
    act(() => setLanguage("it"));
    await waitFor(() =>
      expect(entryOf("repository.deleted").querySelector("p")!.textContent).toBe(
        "Roberta Fontana ha eliminato il repository shop-frontend, che non era in nessun progetto.",
      ),
    );
  });
});

async function openRepositoryDeleted(personId: string): Promise<string> {
  await openAdminLog(personId);
  await waitFor(() => expect(entryOf("repository.deleted")).toBeTruthy());
  return entryOf("repository.deleted").querySelector("p")!.textContent ?? "";
}

describe("repository.linked (RF 3)", () => {
  async function linkToAcq() {
    await deleteRnc();
    as(LAURA);
    expect(await instance.linkRepository("repo-shop", ACQ)).toEqual({ ok: true });
  }

  it("Laura, dal Change log di ACQ: «linked the repository shop-frontend to ACQ», link a Repositories, nulla di RNC", async () => {
    await linkToAcq();
    renderRoute("/p/ACQ/settings/changelog", LAURA);
    await waitFor(() => expect(entryOf("repository.linked")).toBeTruthy());
    const entry = entryOf("repository.linked");
    expect(entry.querySelector("p")!.textContent).toBe(
      "Laura Costa linked the repository shop-frontend to ACQ.",
    );
    const link = within(entry).getByRole("link", { name: "shop-frontend" });
    expect(link.getAttribute("href")).toBe("/p/ACQ/settings/repositories?repo=repo-shop");
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/rnc|ronchi/i);
    expect(html).not.toContain("Tenuta Ronchi");
    act(() => setLanguage("it"));
    await waitFor(() =>
      expect(entryOf("repository.linked").querySelector("p")!.textContent).toBe(
        "Laura Costa ha collegato il repository shop-frontend al progetto ACQ.",
      ),
    );
  });

  it("chi ha changelog.view (Sara), dal registro d'Amministrazione: nulla di RNC", async () => {
    await linkToAcq();
    grantInstancePermission(SARA, "changelog.view");
    await openAdminLog(SARA);
    await waitFor(() => expect(entryOf("repository.linked")).toBeTruthy());
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/rnc|ronchi/i);
    expect(html).not.toContain("Tenuta Ronchi");
  });
});

describe("il link di ogni voce apre la sezione giusta di Settings", () => {
  it("project, repositories e integration", async () => {
    as(ROBERTA);
    const voce = (kind: string, object: { type: string; id: string; label: string }) =>
      recordChange({ kind, actorId: ROBERTA, projectId: ACQ, object, params: {} });
    const acq = { type: "project", id: ACQ, label: "ACQ" };
    const repo = { type: "repository", id: "repo-acq", label: "portale-utenti" };
    voce("project.renamed", acq);
    voce("project.ai_account_changed", acq);
    voce("project.statuses_changed", acq);
    voce("project.plugins_changed", acq);
    voce("project.ingestion_key_regenerated", acq);
    voce("repository.created", repo);
    voce("repository.webhook_secret_regenerated", repo);

    await openAdminLog(ROBERTA);
    await waitFor(() => expect(entries()).toHaveLength(7));
    const href = (kind: string) => entryOf(kind).querySelector("a")?.getAttribute("href") ?? null;
    expect(href("project.renamed")).toBe("/p/ACQ/settings/general");
    expect(href("project.ai_account_changed")).toBe("/p/ACQ/settings/ai");
    expect(href("project.statuses_changed")).toBe("/p/ACQ/settings/statuses");
    expect(href("project.plugins_changed")).toBe("/p/ACQ/settings/plugins");
    expect(href("project.ingestion_key_regenerated")).toBe("/p/ACQ/settings/integration");
    expect(href("repository.created")).toBe("/p/ACQ/settings/repositories?repo=repo-acq");
    expect(href("repository.webhook_secret_regenerated")).toBe("/p/ACQ/settings/integration");
  });

  it("una voce di un archiviato porta alla sua pagina, /archived/RNC", async () => {
    recordChange({
      kind: "project.archived",
      actorId: GIULIA,
      projectId: RNC,
      object: { type: "project", id: RNC, label: "RNC" },
    });
    await openAdminLog(ROBERTA);
    await waitFor(() => expect(entryOf("project.archived")).toBeTruthy());
    const link = within(entryOf("project.archived")).getByRole("link", { name: "RNC" });
    expect(link.getAttribute("href")).toBe("/archived/RNC");
  });

  it("il filtro «Type» del registro di ACQ ha Project settings e Repositories", async () => {
    renderRoute("/p/ACQ/settings/changelog", LAURA);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Type/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitemradio", { name: "Project settings" })).toBeTruthy();
    expect(
      within(menu).getByRole("menuitemradio", { name: "Repositories and environments" }),
    ).toBeTruthy();
  });
});

describe("le voci di un archiviato (P21)", () => {
  beforeEach(() => {
    recordChange({
      kind: "project.archived",
      actorId: GIULIA,
      projectId: RNC,
      object: { type: "project", id: RNC, label: "RNC" },
    });
  });

  it("Giulia la legge dal registro d'Amministrazione; il filtro ha RNC «(archived)»", async () => {
    await openAdminLog(GIULIA);
    await waitFor(() => expect(entryOf("project.archived")).toBeTruthy());
    expect(lines()).toEqual(["Giulia Ferri archived RNC."]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Project/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitemradio", { name: /RNC.*\(archived\)/ })).toBeTruthy();
  });

  it("Laura non la legge, e il filtro non ha RNC, nemmeno nel DOM", async () => {
    grantInstancePermission(LAURA, "changelog.view");
    await openAdminLog(LAURA);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Project/ }));
    await screen.findByRole("menu");
    expect(document.querySelector('[data-change-entry="project.archived"]')).toBeNull();
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/rnc|ronchi/i);
    expect(html).not.toContain("Ronchi");
  });
});
