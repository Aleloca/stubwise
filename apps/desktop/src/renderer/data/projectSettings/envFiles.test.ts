import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __secretValuesForTest } from "../admin/secrets";
import { changelog, projectSettings, resetApi, setLatency } from "../api";
import { markReauthenticated } from "../auth/reauth";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import type { ProjectResult } from "./types";

// I file d'ambiente dei repository, livello dati (area 9c, Task 4): si
// leggono e si scrivono solo con `repos.manage`; i valori vanno nel caveau e
// nessuna lettura, voce o notifica li riporta (RF 2); solo l'ambiente `test`
// arriva a Claude. Persone: Roberta (full admin), Laura (Project Lead in
// ACQ, `repos.manage`), Sara (Contributor in ACQ, senza). STW ha `.env` in
// test (3 variabili) e in production (2).

const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const SARA = "p-sara";
const STW_TEST_FILE = "envf-stw-test";
const STW_PROD_FILE = "envf-stw-prod";

const as = (personId: string) => setSessionPersonId(personId);
let seeded = 0;
const entries = (kind?: string) =>
  state.changelog.slice(seeded).filter((e) => !kind || e.kind === kind);
const fileOf = (id: string) => state.envFiles.find((f) => f.id === id);
const snapshot = () =>
  JSON.stringify({
    envFiles: state.envFiles,
    secrets: __secretValuesForTest().map((s) => s.id),
  });

async function refused(
  call: () => Promise<ProjectResult<object>>,
  expected: Partial<{ error: string; reason: string }>,
) {
  const before = snapshot();
  const written = state.changelog.length;
  expect(await call()).toMatchObject({ ok: false, ...expected });
  expect(snapshot()).toBe(before);
  expect(state.changelog.length).toBe(written);
}

const IMPORT = [
  "# il database",
  "export DATABASE_URL=postgres://prototype-db-value-0001",
  "NOT A LINE AT ALL",
  'NEW_FLAG="quoted-prototype-value-0002"',
  "",
  "1BAD=prototype-value-0003",
  "PAYMENTS_KEY='single-quoted-value-0004'",
].join("\n");

beforeEach(() => {
  setLatency(0);
  resetApi();
  seeded = state.changelog.length;
  as(ROBERTA);
  markReauthenticated(ROBERTA);
});
afterEach(() => resetApi());

describe("la lettura dei file d'ambiente", () => {
  it("un gruppo per ambiente, test per primo; reachesClaude vero solo su test", async () => {
    const { environments } = await projectSettings.listEnvFiles("repo-stw");
    expect(environments.map((e) => [e.kind, e.reachesClaude])).toEqual([
      ["test", true],
      ["staging", false],
      ["production", false],
    ]);
    const test = environments[0]!;
    expect(test.files).toHaveLength(1);
    expect(test.files[0]!.path).toBe(".env");
    expect(test.files[0]!.keys.map((k) => k.key)).toEqual([
      "DATABASE_URL",
      "REDIS_URL",
      "STUBWISE_TEST_TOKEN",
    ]);
    // Di una variabile, solo il nome e quando: niente id del caveau.
    for (const k of test.files[0]!.keys) expect(Object.keys(k).sort()).toEqual(["key", "setAt"]);
    expect(environments[1]!.files).toEqual([]);
  });

  it("senza repos.manage la lettura lancia forbidden; un repository invisibile not_found", async () => {
    as(SARA);
    await expect(projectSettings.listEnvFiles("repo-acq")).rejects.toThrow("forbidden");
    await expect(projectSettings.listEnvFiles("repo-aud")).rejects.toThrow("not_found");
  });
});

describe("le scritture dei file d'ambiente", () => {
  it("l'import riporta importate, sostituite e righe saltate col numero, mai col contenuto", async () => {
    const result = await projectSettings.importEnvFile(STW_PROD_FILE, IMPORT);
    expect(result).toEqual({
      ok: true,
      imported: ["NEW_FLAG", "PAYMENTS_KEY"],
      replaced: ["DATABASE_URL"],
      skipped: [
        { line: 3, reason: "syntax" },
        { line: 6, reason: "key" },
      ],
    });
    expect(fileOf(STW_PROD_FILE)!.vars.map((v) => v.key)).toEqual([
      "DATABASE_URL",
      "SENTRY_DSN",
      "NEW_FLAG",
      "PAYMENTS_KEY",
    ]);
    // Le virgolette non fanno parte del valore.
    const values = __secretValuesForTest()
      .filter((s) => s.kind === "env_value")
      .flatMap((s) => s.values);
    expect(values).toEqual(
      expect.arrayContaining([
        "postgres://prototype-db-value-0001",
        "quoted-prototype-value-0002",
        "single-quoted-value-0004",
      ]),
    );
    const voice = entries("env_file.imported");
    expect(voice).toHaveLength(1);
    expect(voice[0]!.params).toEqual({ count: "3" });
    expect(voice[0]!.object).toMatchObject({ type: "env_file", id: STW_PROD_FILE, label: ".env" });
  });

  it("RF 2: nessuna lettura, voce o notifica contiene i valori importati o impostati", async () => {
    await projectSettings.importEnvFile(STW_TEST_FILE, IMPORT);
    await projectSettings.setEnvVar(
      STW_PROD_FILE,
      "SENTRY_DSN",
      "https://sentry-value-0005@x.test",
    );
    const values = __secretValuesForTest()
      .filter((s) => s.kind === "env_value")
      .flatMap((s) => s.values);
    expect(values.length).toBeGreaterThanOrEqual(4);
    const out = JSON.stringify([
      await projectSettings.listEnvFiles("repo-stw"),
      await projectSettings.listProjectRepositories("prj-stw"),
      await projectSettings.getIntegration("prj-stw"),
      await changelog.listProjectChanges("prj-stw", {}),
      await changelog.listChanges({}),
      state.changelog,
      state.notifications,
      state.envFiles,
    ]);
    for (const v of values) expect(out).not.toContain(v);
  });

  it("set sostituisce il valore: il vecchio esce dal caveau; remove e delete lo dimenticano", async () => {
    await projectSettings.setEnvVar(STW_PROD_FILE, "SENTRY_DSN", "first-prototype-value-0006");
    await projectSettings.setEnvVar(STW_PROD_FILE, "SENTRY_DSN", "second-prototype-value-0007");
    const values = () =>
      __secretValuesForTest()
        .filter((s) => s.kind === "env_value")
        .flatMap((s) => s.values);
    expect(values()).toContain("second-prototype-value-0007");
    expect(values()).not.toContain("first-prototype-value-0006");
    expect(entries("env_var.set").map((e) => e.params)).toEqual([
      { key: "SENTRY_DSN" },
      { key: "SENTRY_DSN" },
    ]);
    expect(await projectSettings.removeEnvVar(STW_PROD_FILE, "SENTRY_DSN")).toEqual({ ok: true });
    expect(values()).not.toContain("second-prototype-value-0007");
    expect(fileOf(STW_PROD_FILE)!.vars.map((v) => v.key)).toEqual(["DATABASE_URL"]);
    expect(entries("env_var.removed")[0]!.params).toEqual({ key: "SENTRY_DSN" });

    await projectSettings.setEnvVar(STW_PROD_FILE, "OTHER", "third-prototype-value-0008");
    expect(await projectSettings.deleteEnvFile(STW_PROD_FILE)).toEqual({ ok: true });
    expect(fileOf(STW_PROD_FILE)).toBeUndefined();
    expect(values()).not.toContain("third-prototype-value-0008");
    expect(entries("env_file.deleted")).toHaveLength(1);
  });

  it("un file nuovo: percorso relativo senza .. né / iniziale, unico per ambiente", async () => {
    const created = await projectSettings.createEnvFile("repo-stw", {
      environmentId: "env-stw-staging",
      path: "apps/api/.env",
    });
    expect(created).toMatchObject({ ok: true });
    const id = (created as { fileId: string }).fileId;
    expect(fileOf(id)).toMatchObject({
      repositoryId: "repo-stw",
      environmentId: "env-stw-staging",
      path: "apps/api/.env",
      vars: [],
    });
    expect(entries("env_file.created")[0]!.object).toMatchObject({ id, label: "apps/api/.env" });
    for (const path of ["/etc/.env", "../.env", "apps/../../.env", "", "  "])
      await refused(
        () => projectSettings.createEnvFile("repo-stw", { environmentId: "env-stw-staging", path }),
        { error: "invalid", reason: "path" },
      );
    await refused(
      () =>
        projectSettings.createEnvFile("repo-stw", {
          environmentId: "env-stw-staging",
          path: "apps/api/.env",
        }),
      { error: "invalid", reason: "path_taken" },
    );
    // Lo stesso percorso in un altro ambiente va bene.
    expect(
      await projectSettings.createEnvFile("repo-stw", {
        environmentId: "env-stw-test",
        path: "apps/api/.env",
      }),
    ).toMatchObject({ ok: true });
    // Un ambiente di un altro progetto non è suo.
    await refused(
      () =>
        projectSettings.createEnvFile("repo-stw", {
          environmentId: "env-aud-prod",
          path: ".env.other",
        }),
      { error: "invalid", reason: "environment" },
    );
  });

  it("una chiave non valida è invalid; un import senza righe valide non chiede riconferma", async () => {
    await refused(() => projectSettings.setEnvVar(STW_PROD_FILE, "1BAD", "x"), {
      error: "invalid",
      reason: "key",
    });
    state.reauth.clear();
    await refused(() => projectSettings.importEnvFile(STW_PROD_FILE, "# solo\n\nNOPE"), {
      error: "invalid",
      reason: "nothing_to_import",
    });
    await refused(() => projectSettings.removeEnvVar(STW_PROD_FILE, "MISSING"), {
      error: "not_found",
    });
  });

  it("senza repos.manage → forbidden su ogni scrittura", async () => {
    as(LAURA);
    markReauthenticated(LAURA);
    expect(
      await projectSettings.createEnvFile("repo-acq", {
        environmentId: "env-acq-prod",
        path: ".env",
      }),
    ).toMatchObject({ ok: true });
    const fileId = state.envFiles.find((f) => f.repositoryId === "repo-acq")!.id;
    as(SARA);
    markReauthenticated(SARA);
    await refused(
      () =>
        projectSettings.createEnvFile("repo-acq", {
          environmentId: "env-acq-prod",
          path: ".env.local",
        }),
      { error: "forbidden" },
    );
    await refused(() => projectSettings.importEnvFile(fileId, "A=1"), { error: "forbidden" });
    await refused(() => projectSettings.setEnvVar(fileId, "A", "1"), { error: "forbidden" });
    await refused(() => projectSettings.removeEnvVar(fileId, "A"), { error: "forbidden" });
    await refused(() => projectSettings.deleteEnvFile(fileId), { error: "forbidden" });
    // Un file di un progetto che non vede (RNC, archiviato) è come uno che non c'è.
    await refused(() => projectSettings.deleteEnvFile("envf-rnc-prod"), { error: "not_found" });
  });

  it("ogni scrittura +R senza riconferma → reauth_required, stato invariato", async () => {
    state.reauth.clear();
    await refused(() => projectSettings.importEnvFile(STW_PROD_FILE, IMPORT), {
      error: "reauth_required",
    });
    await refused(() => projectSettings.setEnvVar(STW_PROD_FILE, "A", "1"), {
      error: "reauth_required",
    });
    await refused(() => projectSettings.removeEnvVar(STW_PROD_FILE, "SENTRY_DSN"), {
      error: "reauth_required",
    });
    await refused(() => projectSettings.deleteEnvFile(STW_PROD_FILE), {
      error: "reauth_required",
    });
    // Creare un file vuoto non chiede la riconferma (nessun segreto).
    expect(
      await projectSettings.createEnvFile("repo-stw", {
        environmentId: "env-stw-staging",
        path: ".env",
      }),
    ).toMatchObject({ ok: true });
  });
});
