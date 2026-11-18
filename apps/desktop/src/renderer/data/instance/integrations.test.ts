import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visiblePeopleFor } from "../access/whoCan";
import { __secretValuesForTest } from "../admin/secrets";
import { changelog, instance, me as meApi, resetApi, setLatency } from "../api";
import { markReauthenticated } from "../auth/reauth";
import { PEOPLE } from "../seed/people";
import { setSessionPersonId } from "../session";
import { state, visibleProjectIds } from "../store";
import { grantInstancePermission, type LocalInstancePermission } from "../viewer";
import type { InstanceResult } from "./types";

// Le integrazioni d'istanza nel livello dati (area 9b, Task 4): account git
// e revisore predefinito, app Google, archiviazione e webhook in uscita (i
// plugin hanno il loro file, `plugins.test.ts`, coi timer finti). Ogni
// rifiuto si controlla con lo stato invariato e nessuna voce del registro.
// Persone: Roberta (full admin), Marco (User: `git_accounts.view` dal
// preset, nient'altro d'istanza), Sara (User, vede pochi progetti; i test le
// danno `git_accounts.manage`).

const ROBERTA = "p-roberta";
const MARCO = "p-marco";
const SARA = "p-sara";
const LUCA = "p-luca";

const as = (personId: string) => setSessionPersonId(personId);
const reauth = (personId: string) => markReauthenticated(personId);
const give = (personId: string, perm: string) =>
  grantInstancePermission(personId, perm as LocalInstancePermission);

const BITBUCKET_AUDIN = "git-bitbucket-audin";
const SEED_WEBHOOK = "wh-seed";
const OPS_URL = "https://ops.example.test/hooks/stubwise";
const GITHUB_STUBWISE = "git-github-stubwise";
const account = (id: string) => state.instance.gitAccounts.find((g) => g.id === id)!;

/** Lo stato d'istanza, le app Google e i segreti, serializzati: un rifiuto non li tocca. */
function snapshot(): string {
  return JSON.stringify({
    instance: state.instance,
    google: state.googleWorkspaces,
    notifications: state.notifications,
    secrets: __secretValuesForTest().map((s) => s.id),
  });
}

async function refused(
  call: () => Promise<InstanceResult<object>>,
  expected: Partial<{ error: string; reason: string }>,
) {
  const before = snapshot();
  const entries = state.changelog.length;
  expect(await call()).toMatchObject({ ok: false, ...expected });
  expect(snapshot()).toBe(before);
  expect(state.changelog.length).toBe(entries);
}

const kinds = () => state.changelog.map((e) => e.kind);
const last = () => state.changelog[state.changelog.length - 1]!;

beforeEach(() => {
  resetApi();
  setLatency(0);
  state.changelog.splice(0);
  as(ROBERTA);
});
afterEach(() => resetApi());

// --- permessi e riconferma ---------------------------------------------------

const newGitHub = () =>
  instance.createGitAccount({
    name: "GitHub Release",
    provider: "github",
    workspace: null,
    token: "ghp_newtoken0001",
  });
const newApp = () =>
  instance.createGoogleApp({
    name: "Acme Workspace",
    domains: ["acme.com"],
    clientId: "123-acme.apps.googleusercontent.com",
    clientSecret: "GOCSPX-acme-secret-9z9z",
  });
const storageWithKey = () =>
  instance.saveStorage({
    endpoint: "https://s3.eu-south-1.amazonaws.com",
    region: "eu-south-1",
    bucket: "stubwise-prod",
    accessKeyId: "AKIAPROTOTYPE4STUB",
    secretAccessKey: "s3-secret-key-k4k4",
  });

describe("permessi", () => {
  /** Ogni scrittura, col permesso che la scrive. */
  const writes: [string, string, () => Promise<InstanceResult<object>>][] = [
    ["createGitAccount", "git_accounts.manage", newGitHub],
    [
      "updateGitAccount",
      "git_accounts.manage",
      () => instance.updateGitAccount(BITBUCKET_AUDIN, { workspace: "audin-srl" }),
    ],
    [
      "replaceGitToken",
      "git_accounts.manage",
      () => instance.replaceGitToken(BITBUCKET_AUDIN, "bb-token-new1"),
    ],
    [
      "validateGitAccount",
      "git_accounts.manage",
      () => instance.validateGitAccount(GITHUB_STUBWISE),
    ],
    ["deleteGitAccount", "git_accounts.manage", () => instance.deleteGitAccount(BITBUCKET_AUDIN)],
    [
      "setDefaultReviewer",
      "git_accounts.manage",
      () => instance.setDefaultReviewer(BITBUCKET_AUDIN, true),
    ],
    ["createGoogleApp", "integrations.manage", newApp],
    [
      "updateGoogleApp",
      "integrations.manage",
      () => instance.updateGoogleApp("gw-example", { name: "Example Inc" }),
    ],
    [
      "replaceGoogleSecret",
      "integrations.manage",
      () => instance.replaceGoogleSecret("gw-example", "GOCSPX-new-1111"),
    ],
    ["deleteGoogleApp", "integrations.manage", () => instance.deleteGoogleApp("gw-example")],
    ["saveStorage", "settings.manage", storageWithKey],
    ["setAttachments", "settings.manage", () => instance.setAttachments(false)],
    ["testStorage", "settings.manage", () => instance.testStorage()],
    // F3 (H-1): i webhook con `integrations.manage`.
    [
      "createWebhook",
      "integrations.manage",
      () => instance.createWebhook({ name: "Ops", url: OPS_URL, format: "generic", events: [] }),
    ],
    [
      "updateWebhook",
      "integrations.manage",
      () => instance.updateWebhook(SEED_WEBHOOK, { enabled: false }),
    ],
    [
      "regenerateWebhookSecret",
      "integrations.manage",
      () => instance.regenerateWebhookSecret(SEED_WEBHOOK),
    ],
    ["deleteWebhook", "integrations.manage", () => instance.deleteWebhook(SEED_WEBHOOK)],
    ["testWebhook", "integrations.manage", () => instance.testWebhook(SEED_WEBHOOK)],
  ];

  for (const [name, , call] of writes)
    it(`${name} senza permesso → forbidden, stato e registro invariati`, async () => {
      reauth(MARCO);
      as(MARCO);
      await refused(call, { error: "forbidden" });
    });

  for (const [name, perm, call] of writes)
    it(`${name} con ${perm} (e la riconferma) si fa`, async () => {
      give(MARCO, perm);
      reauth(MARCO);
      as(MARCO);
      const result = await call();
      // L'app del seme ha caselle e Bitbucket Audin ha repository: si
      // rifiutano per l'uso, non per il permesso.
      if (name === "deleteGitAccount" || name === "deleteGoogleApp")
        expect(result).toMatchObject({ ok: false, error: "in_use" });
      else expect(result).toMatchObject({ ok: true });
    });

  it("le letture: git con .view o .manage, le altre col loro permesso", async () => {
    as(MARCO);
    // Il preset User dà `git_accounts.view` a tutti (Ruling 1). Tre dal 9c (GitHub Shop).
    expect(await instance.listGitAccounts()).toHaveLength(3);
    await expect(instance.listGoogleApps()).rejects.toThrow("forbidden");
    await expect(instance.getStorage()).rejects.toThrow("forbidden");
    await expect(instance.listWebhooks()).rejects.toThrow("forbidden");
    give(MARCO, "settings.manage");
    expect((await instance.getStorage()).bucket).toBe("stubwise-files");
    // F3 (H-1): `settings.manage` non basta più per i webhook.
    await expect(instance.listWebhooks()).rejects.toThrow("forbidden");
    give(MARCO, "integrations.manage");
    expect(await instance.listGoogleApps()).toHaveLength(1);
    expect((await instance.listWebhooks()).map((w) => w.format)).toEqual(["slack"]);
  });

  const plusR: [string, () => Promise<InstanceResult<object>>][] = [
    ["createGitAccount", newGitHub],
    ["replaceGitToken", () => instance.replaceGitToken(BITBUCKET_AUDIN, "bb-token-new1")],
    ["createGoogleApp", newApp],
    ["replaceGoogleSecret", () => instance.replaceGoogleSecret("gw-example", "GOCSPX-new-1111")],
    ["saveStorage con la chiave", storageWithKey],
    // F3: nasce o cambia un segreto, o si toglie un webhook.
    [
      "createWebhook",
      () => instance.createWebhook({ name: "Ops", url: OPS_URL, format: "generic", events: [] }),
    ],
    ["regenerateWebhookSecret", () => instance.regenerateWebhookSecret(SEED_WEBHOOK)],
    ["deleteWebhook", () => instance.deleteWebhook(SEED_WEBHOOK)],
  ];
  for (const [name, call] of plusR)
    it(`${name} senza riconferma → reauth_required; con → ok`, async () => {
      await refused(call, { error: "reauth_required" });
      reauth(ROBERTA);
      expect(await call()).toMatchObject({ ok: true });
    });

  it("eliminare un account o un'app liberi chiede la riconferma", async () => {
    reauth(ROBERTA);
    const created = await newGitHub();
    const app = await newApp();
    resetReauthOnly();
    const accountId = (created as { accountId: string }).accountId;
    const appId = (app as { appId: string }).appId;
    await refused(() => instance.deleteGitAccount(accountId), { error: "reauth_required" });
    await refused(() => instance.deleteGoogleApp(appId), { error: "reauth_required" });
    reauth(ROBERTA);
    expect(await instance.deleteGitAccount(accountId)).toMatchObject({ ok: true });
    expect(await instance.deleteGoogleApp(appId)).toMatchObject({ ok: true });
    expect(kinds().slice(-2)).toEqual(["git_account.deleted", "google_app.deleted"]);
  });

  it("le altre scritture non chiedono la riconferma", async () => {
    expect(
      await instance.updateGitAccount(BITBUCKET_AUDIN, { workspace: "audin-srl" }),
    ).toMatchObject({ ok: true });
    expect(await instance.validateGitAccount(GITHUB_STUBWISE)).toMatchObject({ ok: true });
    expect(await instance.setDefaultReviewer(BITBUCKET_AUDIN, true)).toMatchObject({ ok: true });
    expect(await instance.updateGoogleApp("gw-example", { name: "Example Inc" })).toMatchObject({
      ok: true,
    });
    expect(
      await instance.saveStorage({
        endpoint: "https://s3.eu-south-1.amazonaws.com",
        region: "eu-south-1",
        bucket: "stubwise-prod",
        accessKeyId: "AKIAPROTOTYPE4STUB",
      }),
    ).toMatchObject({ ok: true });
    expect(await instance.setAttachments(false)).toMatchObject({ ok: true });
    expect(await instance.testStorage()).toMatchObject({ ok: true });
    expect(await instance.updateWebhook(SEED_WEBHOOK, { name: "Slack #ops" })).toMatchObject({
      ok: true,
    });
    expect(await instance.testWebhook(SEED_WEBHOOK)).toMatchObject({ ok: true });
  });
});

/** Toglie la riconferma recente di Roberta senza ripristinare lo stato. */
function resetReauthOnly() {
  state.reauth.delete(ROBERTA);
}

// --- RF 1: i segreti scritti non tornano ------------------------------------

describe("RF 1: token git, client secret e chiave S3 non ricompaiono", () => {
  it("né nelle letture, né nel registro, né nelle notifiche", async () => {
    reauth(ROBERTA);
    expect(await newGitHub()).toMatchObject({ ok: true });
    expect(await instance.replaceGitToken(BITBUCKET_AUDIN, "bb-token-replaced-77aa")).toMatchObject(
      { ok: true },
    );
    expect(await newApp()).toMatchObject({ ok: true });
    expect(
      await instance.replaceGoogleSecret("gw-example", "GOCSPX-example-new-5b5b"),
    ).toMatchObject({ ok: true });
    expect(await storageWithKey()).toMatchObject({ ok: true });

    const values = __secretValuesForTest()
      .filter((s) => ["git_token", "google_client_secret", "storage_secret"].includes(s.kind))
      .flatMap((s) => s.values);
    expect(values).toEqual(
      expect.arrayContaining([
        "ghp_newtoken0001",
        "bb-token-replaced-77aa",
        "GOCSPX-acme-secret-9z9z",
        "GOCSPX-example-new-5b5b",
        "s3-secret-key-k4k4",
      ]),
    );

    const out = JSON.stringify({
      git: await instance.listGitAccounts(),
      google: await instance.listGoogleApps(),
      storage: await instance.getStorage(),
      webhooks: await instance.listWebhooks(),
      changes: await changelog.listChanges(),
      notifications: state.notifications,
      mailboxes: await meApi.listMyMailboxes(),
    });
    for (const v of values) expect(out).not.toContain(v);
    expect(out).not.toContain("secretId");

    const git = await instance.listGitAccounts();
    expect(git.find((g) => g.name === "GitHub Release")).toMatchObject({
      last4: "0001",
      lastValidation: null,
    });
    expect(git.find((g) => g.id === BITBUCKET_AUDIN)).toMatchObject({
      last4: "77aa",
      lastValidation: null,
    });
    const apps = await instance.listGoogleApps();
    expect(apps.find((a) => a.id === "gw-example")!.last4).toBe("5b5b");
    expect((await instance.getStorage()).last4).toBe("k4k4");
    expect(kinds()).toEqual([
      "git_account.created",
      "git_account.token_replaced",
      "google_app.created",
      "google_app.secret_replaced",
      "storage.changed",
      "storage.secret_replaced",
    ]);
    // Le voci dei segreti dicono «sostituito», senza prima e dopo.
    for (const e of state.changelog.filter((c) => /secret|token/.test(c.kind)))
      expect([e.before, e.after]).toEqual([null, null]);
  });

  it("la chiave vecchia esce dal caveau quando la si sostituisce", async () => {
    reauth(ROBERTA);
    await instance.replaceGitToken(BITBUCKET_AUDIN, "bb-token-one-1111");
    await instance.replaceGitToken(BITBUCKET_AUDIN, "bb-token-two-2222");
    const tokens = __secretValuesForTest()
      .filter((s) => s.kind === "git_token")
      .flatMap((s) => s.values);
    expect(tokens).toEqual(["bb-token-two-2222"]);
  });
});

// --- account git -------------------------------------------------------------

describe("account git", () => {
  it("la lista dice i repository visibili e conta gli altri", async () => {
    const rows = await instance.listGitAccounts();
    expect(rows.find((r) => r.id === BITBUCKET_AUDIN)).toMatchObject({
      name: "Bitbucket Audin",
      provider: "bitbucket",
      workspace: "audin",
      last4: "k2p8",
      hiddenRepositories: 0,
    });
    // CBV, i tre di AUD e, dal 9c, `portale-utenti` di ACQ.
    expect(rows.find((r) => r.id === BITBUCKET_AUDIN)!.repositories).toHaveLength(5);
    expect(rows[0]).not.toHaveProperty("secretId");
  });

  it("Bitbucket senza workspace → invalid workspace; nome e token obbligatori", async () => {
    reauth(ROBERTA);
    const base = { name: "BB", provider: "bitbucket" as const, workspace: "x", token: "t-1234" };
    await refused(() => instance.createGitAccount({ ...base, workspace: null }), {
      error: "invalid",
      reason: "workspace",
    });
    await refused(() => instance.createGitAccount({ ...base, workspace: "  " }), {
      error: "invalid",
      reason: "workspace",
    });
    await refused(() => instance.createGitAccount({ ...base, name: " " }), {
      error: "invalid",
      reason: "name",
    });
    await refused(() => instance.createGitAccount({ ...base, token: "" }), {
      error: "invalid",
      reason: "token",
    });
    await refused(() => instance.createGitAccount({ ...base, name: "bitbucket audin" }), {
      error: "conflict",
    });
  });

  it("creato: la voce dice la piattaforma come si scrive; GitHub senza workspace", async () => {
    reauth(ROBERTA);
    const res = await instance.createGitAccount({
      name: "GitHub Release",
      provider: "github",
      workspace: "ignored",
      token: "ghp_abcd9999",
    });
    expect(res).toMatchObject({ ok: true });
    const created = state.instance.gitAccounts.find((g) => g.name === "GitHub Release")!;
    expect(created).toMatchObject({ workspace: null, defaultReviewer: false, last4: "9999" });
    expect(last()).toMatchObject({
      kind: "git_account.created",
      object: { type: "git_account", id: created.id, label: "GitHub Release" },
      params: { provider: "GitHub" },
    });
  });

  it("modificato: prima e dopo coi soli campi cambiati, in valori stabili", async () => {
    expect(
      await instance.updateGitAccount(BITBUCKET_AUDIN, {
        name: "Bitbucket Audin",
        workspace: "audin-srl",
      }),
    ).toMatchObject({ ok: true });
    expect(account(BITBUCKET_AUDIN).workspace).toBe("audin-srl");
    expect(last()).toMatchObject({ kind: "git_account.updated" });
    expect(JSON.parse(last().before!)).toEqual({ workspace: "audin" });
    expect(JSON.parse(last().after!)).toEqual({ workspace: "audin-srl" });
    // Niente di cambiato: nessuna voce.
    const n = state.changelog.length;
    expect(
      await instance.updateGitAccount(BITBUCKET_AUDIN, { workspace: "audin-srl" }),
    ).toMatchObject({ ok: true });
    expect(state.changelog.length).toBe(n);
    await refused(() => instance.updateGitAccount(BITBUCKET_AUDIN, { workspace: "" }), {
      error: "invalid",
      reason: "workspace",
    });
    await refused(() => instance.updateGitAccount("git-nope", { name: "x" }), {
      error: "not_found",
    });
  });

  it("verifica con l'esito scelto nel riquadro, poi di nuovo ok", async () => {
    expect(await instance.simulateNextTest(GITHUB_STUBWISE, "invalid_credentials")).toMatchObject({
      ok: true,
    });
    expect(await instance.validateGitAccount(GITHUB_STUBWISE)).toMatchObject({
      ok: true,
      outcome: "invalid_credentials",
    });
    expect(account(GITHUB_STUBWISE).lastValidation?.outcome).toBe("invalid_credentials");
    expect(await instance.validateGitAccount(GITHUB_STUBWISE)).toMatchObject({ outcome: "ok" });
    // Una verifica non è una modifica.
    expect(kinds()).toEqual([]);
  });

  it("RF 2: Sara con git_accounts.manage elimina Bitbucket Audin → in_use coi suoi repository, gli altri contati", async () => {
    give(SARA, "git_accounts.manage");
    reauth(SARA);
    as(SARA);
    const visible = visibleProjectIds(SARA);
    const repos = state.repositories.filter((r) => r.gitAccountId === BITBUCKET_AUDIN);
    const seen = repos.filter((r) => visible.has(r.projectId));
    const hidden = repos.length - seen.length;
    // Il seme è fatto apposta: Sara ne vede alcuni, non tutti.
    expect(seen.length).toBeGreaterThan(0);
    expect(hidden).toBeGreaterThan(0);

    const before = snapshot();
    const res = await instance.deleteGitAccount(BITBUCKET_AUDIN);
    expect(res).toEqual({
      ok: false,
      error: "in_use",
      usedBy: seen.map((r) => ({
        label: r.name,
        projectCode: state.projectsById.get(r.projectId)!.code,
      })),
      hiddenCount: hidden,
    });
    expect(snapshot()).toBe(before);
    const hiddenNames = repos.filter((r) => !visible.has(r.projectId)).map((r) => r.name);
    const hiddenCodes = repos
      .filter((r) => !visible.has(r.projectId))
      .map((r) => state.projectsById.get(r.projectId)!.code);
    const text = JSON.stringify(res);
    for (const n of [...hiddenNames, ...hiddenCodes]) expect(text).not.toContain(n);

    // La lista dice lo stesso: i nascosti solo contati.
    const row = (await instance.listGitAccounts()).find((r) => r.id === BITBUCKET_AUDIN)!;
    expect(row.hiddenRepositories).toBe(hidden);
    expect(row.repositories.map((r) => r.name)).toEqual(seen.map((r) => r.name));
    // In uso anche senza riconferma: il rifiuto per l'uso viene prima.
    resetReauthOnlyFor(SARA);
    expect(await instance.deleteGitAccount(BITBUCKET_AUDIN)).toMatchObject({ error: "in_use" });
  });
});

function resetReauthOnlyFor(personId: string) {
  state.reauth.delete(personId);
}

// --- revisore predefinito ----------------------------------------------------

describe("revisore predefinito", () => {
  it("uno per ambito: lo stesso ambito lo sostituisce, un altro convive", async () => {
    reauth(ROBERTA);
    const created = (await newGitHub()) as { ok: true; accountId: string };
    expect(account(GITHUB_STUBWISE).defaultReviewer).toBe(true);

    expect(await instance.setDefaultReviewer(created.accountId, true)).toEqual({
      ok: true,
      replaced: "GitHub Stubwise",
    });
    expect(account(created.accountId).defaultReviewer).toBe(true);
    expect(account(GITHUB_STUBWISE).defaultReviewer).toBe(false);
    expect(last()).toMatchObject({
      kind: "git_account.default_reviewer_changed",
      object: { id: created.accountId, label: "GitHub Release" },
      before: "GitHub Stubwise",
      after: "GitHub Release",
    });

    // Bitbucket (workspace audin) è un altro ambito: convivono.
    expect(await instance.setDefaultReviewer(BITBUCKET_AUDIN, true)).toEqual({
      ok: true,
      replaced: null,
    });
    expect(account(BITBUCKET_AUDIN).defaultReviewer).toBe(true);
    expect(account(created.accountId).defaultReviewer).toBe(true);

    // Un altro workspace Bitbucket è un altro ambito ancora.
    const other = (await instance.createGitAccount({
      name: "Bitbucket Other",
      provider: "bitbucket",
      workspace: "other",
      token: "bb-other-0000",
    })) as { ok: true; accountId: string };
    expect(await instance.setDefaultReviewer(other.accountId, true)).toEqual({
      ok: true,
      replaced: null,
    });
    expect(account(BITBUCKET_AUDIN).defaultReviewer).toBe(true);
  });

  it("la lettura dice chi verrebbe sostituito (Task 10: la pagina non ricalcola l'ambito)", async () => {
    reauth(ROBERTA);
    const created = (await newGitHub()) as { ok: true; accountId: string };
    const rows = await instance.listGitAccounts();
    const of = (id: string) => rows.find((r) => r.id === id)!;
    expect(of(created.accountId).replacesAsReviewer).toBe("GitHub Stubwise");
    // Chi lo è già, e un altro ambito senza predefinito: nessuno.
    expect(of(GITHUB_STUBWISE).replacesAsReviewer).toBeNull();
    expect(of(BITBUCKET_AUDIN).replacesAsReviewer).toBeNull();
  });

  it("toglierlo: nessuno sostituito, la voce dice On → Off del campo", async () => {
    expect(await instance.setDefaultReviewer(GITHUB_STUBWISE, false)).toEqual({
      ok: true,
      replaced: null,
    });
    expect(account(GITHUB_STUBWISE).defaultReviewer).toBe(false);
    expect(last()).toMatchObject({ kind: "git_account.updated" });
    expect(JSON.parse(last().before!)).toEqual({ defaultReviewer: true });
    expect(JSON.parse(last().after!)).toEqual({ defaultReviewer: false });
  });

  it("cambiare il workspace di un predefinito lo spegne, nella stessa voce: un solo predefinito nel nuovo ambito", async () => {
    reauth(ROBERTA);
    const other = (await instance.createGitAccount({
      name: "Bitbucket Other",
      provider: "bitbucket",
      workspace: "other",
      token: "bb-other-0000",
    })) as { ok: true; accountId: string };
    await instance.setDefaultReviewer(other.accountId, true);
    await instance.setDefaultReviewer(BITBUCKET_AUDIN, true);
    const entries = state.changelog.length;

    expect(await instance.updateGitAccount(BITBUCKET_AUDIN, { workspace: "other" })).toEqual({
      ok: true,
    });
    expect(account(BITBUCKET_AUDIN)).toMatchObject({ workspace: "other", defaultReviewer: false });
    const inScope = state.instance.gitAccounts.filter(
      (g) => g.provider === "bitbucket" && g.workspace === "other" && g.defaultReviewer,
    );
    expect(inScope.map((g) => g.id)).toEqual([other.accountId]);
    // Una sola voce, col workspace e il revisore insieme.
    expect(state.changelog.length).toBe(entries + 1);
    expect(last()).toMatchObject({ kind: "git_account.updated" });
    expect(JSON.parse(last().before!)).toEqual({ workspace: "audin", defaultReviewer: true });
    expect(JSON.parse(last().after!)).toEqual({ workspace: "other", defaultReviewer: false });

    // Il solo nome non lo tocca.
    await instance.setDefaultReviewer(GITHUB_STUBWISE, true);
    expect(await instance.updateGitAccount(GITHUB_STUBWISE, { name: "GitHub Main" })).toEqual({
      ok: true,
    });
    expect(account(GITHUB_STUBWISE).defaultReviewer).toBe(true);
  });
});

// --- app Google ----------------------------------------------------------------

describe("app Google", () => {
  it("un'app nuova compare fra quelle da collegare in Preferenze", async () => {
    reauth(ROBERTA);
    expect(await newApp()).toMatchObject({ ok: true });
    as(MARCO);
    const mine = await meApi.listMyMailboxes();
    expect(mine.workspaces.map((w) => w.name)).toContain("Acme Workspace");
  });

  it("la lista conta le caselle collegate", async () => {
    const [example] = await instance.listGoogleApps();
    const count = state.mailboxes.filter((b) => b.email.endsWith("@example.com")).length;
    expect(count).toBeGreaterThan(0);
    expect(example).toMatchObject({
      id: "gw-example",
      domains: ["example.com"],
      last4: "q8vz",
      mailboxCount: count,
    });
    expect(example).not.toHaveProperty("secretId");
  });

  it("la lista dice di chi sono le caselle: le persone visibili per nome, le altre contate (R-G5)", async () => {
    give(LUCA, "integrations.manage");
    as(LUCA);
    const people = visiblePeopleFor(LUCA);
    const boxes = state.mailboxes.filter((b) => b.email.endsWith("@example.com"));
    const seen = boxes.filter((b) => people.has(b.personId));
    const [example] = await instance.listGoogleApps();
    expect(example).toMatchObject({
      mailboxCount: boxes.length,
      mailboxPeople: seen.map((b) => PEOPLE.find((p) => p.id === b.personId)!.name),
      hiddenMailboxCount: boxes.length - seen.length,
    });
    expect(example!.hiddenMailboxCount).toBeGreaterThan(0);
  });

  it("il rifiuto di un dominio nomina il dominio in causa", async () => {
    reauth(ROBERTA);
    const base = { name: "Acme", clientId: "c-1", clientSecret: "s-1234" };
    expect(await instance.createGoogleApp({ ...base, domains: ["acme.com", "acme"] })).toEqual({
      ok: false,
      error: "invalid",
      reason: "domain",
      name: "acme",
    });
    expect(
      await instance.createGoogleApp({ ...base, domains: ["acme.com", "Example.com"] }),
    ).toEqual({ ok: false, error: "invalid", reason: "domain_taken", name: "example.com" });
  });

  it("domini: malformato o già di un'altra app → invalid", async () => {
    reauth(ROBERTA);
    const base = {
      name: "Acme",
      domains: ["acme.com"],
      clientId: "c-1",
      clientSecret: "s-1234",
    };
    await refused(() => instance.createGoogleApp({ ...base, domains: ["acme"] }), {
      error: "invalid",
      reason: "domain",
    });
    await refused(() => instance.createGoogleApp({ ...base, domains: ["Example.com"] }), {
      error: "invalid",
      reason: "domain_taken",
    });
    await refused(() => instance.createGoogleApp({ ...base, domains: [] }), {
      error: "invalid",
      reason: "domains",
    });
    await refused(() => instance.createGoogleApp({ ...base, clientSecret: " " }), {
      error: "invalid",
      reason: "client_secret",
    });
    await refused(() => instance.updateGoogleApp("gw-example", { domains: ["not a domain"] }), {
      error: "invalid",
      reason: "domain",
    });
  });

  it("un'app con caselle non si elimina: le persone visibili per nome, le altre contate", async () => {
    reauth(ROBERTA);
    const res = await instance.deleteGoogleApp("gw-example");
    expect(res).toMatchObject({ ok: false, error: "in_use", hiddenCount: 0 });
    const names = (res as { usedBy: { label: string }[] }).usedBy.map((u) => u.label);
    expect(names).toContain("Giulia Ferri");
    expect(state.googleWorkspaces.map((w) => w.id)).toContain("gw-example");
  });

  it("togliere un dominio con caselle → in_use come l'eliminazione, prima di scrivere (R-G5)", async () => {
    // Luca vede due delle tre persone con una casella @example.com.
    give(LUCA, "integrations.manage");
    as(LUCA);
    const people = visiblePeopleFor(LUCA);
    const boxes = state.mailboxes.filter((b) => b.email.endsWith("@example.com"));
    const seen = boxes.filter((b) => people.has(b.personId));
    // Il caso conta solo se Sara ne vede alcune e non altre.
    expect(seen.length).toBeGreaterThan(0);
    expect(boxes.length - seen.length).toBeGreaterThan(0);

    const before = snapshot();
    const res = await instance.updateGoogleApp("gw-example", { domains: ["example.org"] });
    expect(res).toEqual({
      ok: false,
      error: "in_use",
      usedBy: seen.map((b) => ({
        label: PEOPLE.find((p) => p.id === b.personId)!.name,
        projectCode: null,
      })),
      hiddenCount: boxes.length - seen.length,
    });
    expect(snapshot()).toBe(before);
    expect(kinds()).toEqual([]);
    const hiddenNames = boxes
      .filter((b) => !people.has(b.personId))
      .map((b) => PEOPLE.find((p) => p.id === b.personId)!.name);
    for (const n of hiddenNames) expect(JSON.stringify(res)).not.toContain(n);

    // Aggiungere un dominio, o togliere uno senza caselle, si fa.
    expect(
      await instance.updateGoogleApp("gw-example", { domains: ["example.com", "example.org"] }),
    ).toEqual({ ok: true });
    expect(await instance.updateGoogleApp("gw-example", { domains: ["example.com"] })).toEqual({
      ok: true,
    });
  });

  it("modificata: i domini nel prima/dopo", async () => {
    expect(
      await instance.updateGoogleApp("gw-example", { domains: ["example.com", "example.org"] }),
    ).toMatchObject({ ok: true });
    expect(last()).toMatchObject({ kind: "google_app.updated" });
    expect(JSON.parse(last().before!)).toEqual({ domains: ["example.com"] });
    expect(JSON.parse(last().after!)).toEqual({ domains: ["example.com", "example.org"] });
  });
});

// --- archiviazione -------------------------------------------------------------

describe("archiviazione", () => {
  it("storageAllowsUploads: vero col seme, falso con gli allegati spenti o dopo una prova fallita", async () => {
    expect(instance.storageAllowsUploads()).toBe(true);
    expect((await instance.getStorage()).status).toBe("on");

    expect(await instance.setAttachments(false)).toMatchObject({ ok: true });
    expect(instance.storageAllowsUploads()).toBe(false);
    expect((await instance.getStorage()).status).toBe("attachments_off");
    expect(JSON.parse(last().before!)).toEqual({ attachments: true });
    expect(JSON.parse(last().after!)).toEqual({ attachments: false });

    await instance.setAttachments(true);
    expect(instance.storageAllowsUploads()).toBe(true);
    await instance.simulateNextTest("storage", "unreachable");
    expect(await instance.testStorage()).toMatchObject({ ok: true, outcome: "unreachable" });
    expect(instance.storageAllowsUploads()).toBe(false);
    expect((await instance.getStorage()).status).toBe("check_failed");
    expect(await instance.testStorage()).toMatchObject({ outcome: "ok" });
    expect(instance.storageAllowsUploads()).toBe(true);
  });

  it("senza chiave salvata serve la chiave; istanza vuota: «not set up», niente caricamenti", async () => {
    state.instance.storage = {
      endpoint: "",
      region: "",
      bucket: "",
      accessKeyId: "",
      secretId: null,
      last4: null,
      attachmentsEnabled: false,
      lastTest: null,
    };
    expect((await instance.getStorage()).status).toBe("not_set_up");
    expect(instance.storageAllowsUploads()).toBe(false);
    await refused(() => instance.setAttachments(true), { error: "invalid", reason: "not_set_up" });
    await refused(() => instance.testStorage(), { error: "invalid", reason: "not_set_up" });
    await refused(
      () =>
        instance.saveStorage({
          endpoint: "https://s3.example.test",
          region: "eu",
          bucket: "files",
          accessKeyId: "AK",
        }),
      { error: "invalid", reason: "secret_access_key" },
    );
    await refused(
      () =>
        instance.saveStorage({
          endpoint: "not a url",
          region: "eu",
          bucket: "files",
          accessKeyId: "AK",
          secretAccessKey: "k",
        }),
      { error: "invalid", reason: "endpoint" },
    );
  });

  it("salvare la configurazione: i campi cambiati nel prima/dopo, la prova va rifatta", async () => {
    expect(
      await instance.saveStorage({
        endpoint: "https://s3.eu-south-1.amazonaws.com",
        region: "eu-south-1",
        bucket: "stubwise-prod",
        accessKeyId: "AKIAPROTOTYPE4STUB",
      }),
    ).toMatchObject({ ok: true });
    expect(kinds()).toEqual(["storage.changed"]);
    expect(JSON.parse(last().before!)).toEqual({ bucket: "stubwise-files" });
    expect(JSON.parse(last().after!)).toEqual({ bucket: "stubwise-prod" });
    expect((await instance.getStorage()).lastTest).toBeNull();
  });
});

// --- webhook -------------------------------------------------------------------

describe("webhook in uscita", () => {
  it("i 21 eventi dello shape: 13 del web, 8 del catalogo; niente posta, Google né risposte dei clienti", () => {
    const ids = instance.WEBHOOK_EVENTS.map((e) => e.id);
    expect(ids).toHaveLength(21);
    expect(new Set(ids).size).toBe(21);
    expect(
      instance.WEBHOOK_EVENTS.filter((e) => e.source === "web")
        .map((e) => e.id)
        .sort(),
    ).toEqual(
      [
        "ticket.created",
        "job.pr_opened",
        "job.pr_closed",
        "job.held",
        "job.plan_review",
        "job.budget_held",
        "review.completed",
        "job.failed",
        "docs.limit_paused",
        "monitor",
        "job.awaiting_input",
        "project.pulse",
        "project.brief",
      ].sort(),
    );
    expect(
      instance.WEBHOOK_EVENTS.filter((e) => e.source === "catalog")
        .map((e) => e.id)
        .sort(),
    ).toEqual(
      [
        "release.merged",
        "release.succeeded",
        "release.failed",
        "pr.analysis_issues",
        "docs.release_note",
        "task.created_by_automation",
        "support.request",
        "server.diagnosis_ready",
      ].sort(),
    );
    for (const banned of [
      "google.proposal",
      "support.customer_replied",
      "security.alert",
      "pr.opened",
      "task.created",
      "pr.corrected",
    ])
      expect(ids).not.toContain(banned);
    expect(ids.filter((id) => /mail|google|security/.test(id))).toEqual([]);
  });

  it("il seme: il webhook di prima migrato, «Webhook», col segreto impostato ma mai mostrato", async () => {
    const [w, ...rest] = await instance.listWebhooks();
    expect(rest).toEqual([]);
    expect(w).toMatchObject({
      id: SEED_WEBHOOK,
      name: "Webhook",
      format: "slack",
      enabled: true,
      url: "https://hooks.slack.com/services/T01AUDIN/B07STUB/prototype",
      events: ["ticket.created", "job.failed", "job.pr_opened", "monitor"],
      secretSet: true,
    });
    expect(JSON.stringify(w)).not.toMatch(/secret"\s*:\s*"|whsec_/);
  });

  it("creare: con la riconferma, il segreto esce UNA volta e mai da una lettura; la voce senza valori", async () => {
    reauth(ROBERTA);
    const r = await instance.createWebhook({
      name: "Ops",
      url: OPS_URL,
      format: "generic",
      events: ["release.failed", "job.failed"],
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.secret).toMatch(/^whsec_/);
    expect(r.webhook).toMatchObject({
      name: "Ops",
      enabled: true,
      events: ["job.failed", "release.failed"],
      secretSet: true,
    });
    const out = JSON.stringify({
      list: await instance.listWebhooks(),
      one: await instance.getWebhook(r.webhook.id),
      changes: state.changelog,
    });
    expect(out).not.toContain(r.secret);
    expect(last()).toMatchObject({
      kind: "webhook.created",
      object: { type: "webhook", id: r.webhook.id, label: "Ops" },
      params: { format: "generic", events: "job.failed,release.failed" },
    });
  });

  it("modificare: senza riconferma; la voce ha i soli campi cambiati, l'URL compreso", async () => {
    expect(state.reauth.has(ROBERTA)).toBe(false);
    const url = "https://hooks.slack.com/services/T02NEW/B08NEW/another";
    expect(await instance.updateWebhook(SEED_WEBHOOK, { url })).toEqual({ ok: true });
    expect((await instance.getWebhook(SEED_WEBHOOK)).url).toBe(url);
    expect(last()).toMatchObject({ kind: "webhook.updated" });
    expect(JSON.parse(last().before!)).toEqual({
      url: "https://hooks.slack.com/services/T01AUDIN/B07STUB/prototype",
    });
    expect(JSON.parse(last().after!)).toEqual({ url });
    // Cambiare l'indirizzo rimette la prova a «non ancora provata».
    expect((await instance.getWebhook(SEED_WEBHOOK)).lastTest).toBeNull();
  });

  it("gli eventi: un id fuori catalogo rifiutato; il registro dice quali, nell'ordine dello shape", async () => {
    await refused(
      () =>
        instance.updateWebhook(SEED_WEBHOOK, {
          events: ["ticket.created", "support.customer_replied"],
        }),
      { error: "invalid", reason: "events" },
    );
    expect(
      await instance.updateWebhook(SEED_WEBHOOK, {
        events: ["release.failed", "ticket.created", "job.failed", "monitor"],
      }),
    ).toEqual({ ok: true });
    expect(JSON.parse(last().before!)).toEqual({
      events: ["ticket.created", "job.failed", "job.pr_opened", "monitor"],
    });
    expect(JSON.parse(last().after!)).toEqual({
      events: ["ticket.created", "job.failed", "release.failed", "monitor"],
    });
  });

  it("URL https e nome non vuoto, alla creazione e alla modifica", async () => {
    reauth(ROBERTA);
    for (const url of ["http://hooks.example.test/x", "not a url", "ftp://x.test/a", ""])
      await refused(() => instance.updateWebhook(SEED_WEBHOOK, { url }), {
        error: "invalid",
        reason: "url",
      });
    await refused(
      () => instance.createWebhook({ name: "  ", url: OPS_URL, format: "slack", events: [] }),
      { error: "invalid", reason: "name" },
    );
  });

  it("al più 20 webhook: il ventunesimo è webhook_limit", async () => {
    reauth(ROBERTA);
    for (let i = state.instance.webhooks.length; i < instance.WEBHOOK_LIMIT; i++)
      expect(
        await instance.createWebhook({ name: `W${i}`, url: OPS_URL, format: "slack", events: [] }),
      ).toMatchObject({ ok: true });
    await refused(
      () => instance.createWebhook({ name: "Extra", url: OPS_URL, format: "slack", events: [] }),
      { error: "invalid", reason: "webhook_limit" },
    );
  });

  it("rigenerare il segreto: con la riconferma, quello nuovo una volta, la voce senza valori", async () => {
    reauth(ROBERTA);
    const r = await instance.regenerateWebhookSecret(SEED_WEBHOOK);
    if (!r.ok) throw new Error(r.error);
    expect(r.secret).toMatch(/^whsec_/);
    expect(last()).toMatchObject({ kind: "webhook.secret_replaced", before: null, after: null });
    expect(JSON.stringify(state.changelog)).not.toContain(r.secret);
    expect((await instance.getWebhook(SEED_WEBHOOK)).secretRotatedAt).toBe(r.secretRotatedAt);
  });

  it("eliminare: con la riconferma; il webhook sparisce, la voce resta e non porta più a niente", async () => {
    reauth(ROBERTA);
    expect(await instance.deleteWebhook(SEED_WEBHOOK)).toEqual({ ok: true });
    expect(await instance.listWebhooks()).toEqual([]);
    await expect(instance.getWebhook(SEED_WEBHOOK)).rejects.toThrow("not_found");
    expect(last()).toMatchObject({ kind: "webhook.deleted" });
    const [entry] = await changelog.listChanges({ kind: "webhook.deleted" });
    expect(entry).toMatchObject({ objectDeleted: true, objectLink: null });
  });

  it("la prova di UN webhook risponde con l'esito scelto, anche da spento", async () => {
    expect(await instance.updateWebhook(SEED_WEBHOOK, { enabled: false })).toEqual({ ok: true });
    await instance.simulateNextTest("webhook", "unreachable");
    expect(await instance.testWebhook(SEED_WEBHOOK)).toEqual({ ok: true, outcome: "unreachable" });
    expect((await instance.getWebhook(SEED_WEBHOOK)).lastTest?.outcome).toBe("unreachable");
    expect(await instance.testWebhook(SEED_WEBHOOK)).toEqual({ ok: true, outcome: "ok" });
    await refused(() => instance.testWebhook("wh-nope"), { error: "not_found" });
  });

  it("l'anteprima per Slack, Discord e JSON, nella lingua dei contenuti", async () => {
    const slack = await instance.previewWebhook("ticket.created", "slack");
    expect(slack).toMatch(/New task in ACQ/);
    expect(slack).toMatch(/\*ACQ-\d+\*/);
    expect(slack).toMatch(/<https:\/\/[^|]+\|Open>/);

    const discord = await instance.previewWebhook("ticket.created", "discord");
    expect(discord).toMatch(/\*\*ACQ-\d+\*\*/);
    expect(discord).toMatch(/\[Open\]\(https:\/\/[^)]+\)/);

    const json = JSON.parse(await instance.previewWebhook("ticket.created", "generic")) as Record<
      string,
      unknown
    >;
    expect(json).toMatchObject({ event: "ticket.created", project: "ACQ" });
    expect(String(json.message)).toMatch(/New task in ACQ/);

    for (const e of instance.WEBHOOK_EVENTS)
      for (const f of ["slack", "discord", "generic"] as const)
        expect((await instance.previewWebhook(e.id, f)).length).toBeGreaterThan(10);

    state.instance.budget.contentLanguage = "it";
    expect(await instance.previewWebhook("ticket.created", "slack")).toMatch(/Nuova task in ACQ/);
  });
});
