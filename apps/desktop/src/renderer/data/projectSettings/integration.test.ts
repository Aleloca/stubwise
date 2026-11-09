import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visiblePeopleFor } from "../access/whoCan";
import { __secretValuesForTest } from "../admin/secrets";
import { changelog, projectSettings, resetApi, setLatency } from "../api";
import { markReauthenticated } from "../auth/reauth";
import { PEOPLE } from "../seed/people";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { grantProjectPermission } from "../viewer";

// Integration del progetto, livello dati (area 9c, Task 4): la chiave
// d'ingestione e il secret del webhook git di ogni repository si generano
// alla rigenerazione (+R) e il valore esce UNA volta, nel risultato; dopo
// restano le ultime 4. DSN, snippet e autenticazione del webhook in arrivo
// si leggono con la chiave mascherata. Persone: Laura (Project Lead in ACQ:
// `project.settings.manage` e `repos.manage`), Sara (Contributor in ACQ:
// nessuno dei due).

const LAURA = "p-laura";
const SARA = "p-sara";
const ROBERTA = "p-roberta";
const ACQ = "prj-acq";
const AUD = "prj-aud";
const RNC = "prj-rnc";

const as = (personId: string) => setSessionPersonId(personId);
let seeded = 0;
const entries = (kind?: string) =>
  state.changelog.slice(seeded).filter((e) => !kind || e.kind === kind);
const secretValues = (kind: string) =>
  __secretValuesForTest()
    .filter((s) => s.kind === kind)
    .flatMap((s) => s.values);

beforeEach(() => {
  setLatency(0);
  resetApi();
  seeded = state.changelog.length;
});
afterEach(() => resetApi());

describe("la lettura di Integration", () => {
  it("Laura legge ACQ: chiave mascherata, DSN, snippet, webhook in arrivo, webhook git", async () => {
    as(LAURA);
    const view = (await projectSettings.getIntegration(ACQ))!;
    const last4 = state.projectSettings.get(ACQ)!.ingestion.last4;
    expect(view.ingestion.last4).toBe(last4);
    expect(view.ingestion.maskedDsn).toBe(`https://••••${last4}@stubwise.example.test/ingest/ACQ`);
    expect(view.ingestion.maskedSnippet).toContain(`dsn: "${view.ingestion.maskedDsn}"`);
    expect(view.ingestion.maskedSnippet.split("\n")).toHaveLength(6);
    expect(view.inbound).toEqual({
      url: "https://stubwise.example.test/api/inbound/ACQ/ticket",
      auth: `Bearer ••••${last4}`,
    });
    expect(view.gitWebhooks).toEqual([
      {
        repositoryId: "repo-acq",
        name: "portale-utenti",
        url: "https://stubwise.example.test/webhooks/git/repo-acq",
        secretLast4: null,
        canRegenerate: true,
      },
    ]);
    expect(view.canRegenerateKey).toBe(true);
    expect(view.guide).toContain(view.ingestion.maskedDsn);
  });

  it("Sara legge Integration con canRegenerateKey false e nessun secret da rigenerare", async () => {
    as(SARA);
    const view = (await projectSettings.getIntegration(ACQ))!;
    expect(view.canRegenerateKey).toBe(false);
    // Contributor: non vede i repository, quindi nemmeno i loro webhook.
    expect(view.gitWebhooks).toEqual([]);
    grantProjectPermission(SARA, ACQ, "repos.view" as never);
    const withRepos = (await projectSettings.getIntegration(ACQ))!;
    expect(withRepos.gitWebhooks.map((w) => [w.name, w.canRegenerate])).toEqual([
      ["portale-utenti", false],
    ]);
    expect(await projectSettings.getIntegration(AUD)).toBeNull();
    as(ROBERTA);
    expect(await projectSettings.getIntegration(RNC)).toBeNull();
  });
});

describe("la rigenerazione della chiave d'ingestione", () => {
  it("RF 2: il valore è nel risultato e nel caveau, in nessuna lettura dopo; il DSN finisce con le stesse 4", async () => {
    as(LAURA);
    markReauthenticated(LAURA);
    const result = await projectSettings.regenerateIngestionKey(ACQ);
    expect(result).toMatchObject({ ok: true });
    const { key, dsn, snippet } = result as { key: string; dsn: string; snippet: string };
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(dsn).toBe(`https://${key}@stubwise.example.test/ingest/ACQ`);
    expect(snippet).toContain(dsn);
    expect(secretValues("ingestion_key")).toEqual([key]);

    const view = (await projectSettings.getIntegration(ACQ))!;
    expect(view.ingestion.last4).toBe(key.slice(-4));
    expect(view.ingestion.maskedDsn).toBe(
      `https://••••${key.slice(-4)}@stubwise.example.test/ingest/ACQ`,
    );
    const out = JSON.stringify([
      view,
      await projectSettings.getProjectSettings(ACQ),
      await changelog.listProjectChanges(ACQ, {}),
      state.changelog,
      state.notifications,
      state.projectSettings.get(ACQ),
    ]);
    expect(out).not.toContain(key);
    expect(entries("project.ingestion_key_regenerated")).toHaveLength(1);
  });

  it("la chiave sa chi l'ha creata (I2): nel seme nessuno, dopo la rigenerazione chi l'ha fatta", async () => {
    as(LAURA);
    expect((await projectSettings.getIntegration(ACQ))!.ingestion.createdBy).toBeNull();
    markReauthenticated(LAURA);
    await projectSettings.regenerateIngestionKey(ACQ);
    expect(state.projectSettings.get(ACQ)!.ingestion.createdById).toBe(LAURA);
    const laura = PEOPLE.find((p) => p.id === LAURA)!;
    expect((await projectSettings.getIntegration(ACQ))!.ingestion.createdBy).toEqual({
      id: LAURA,
      name: laura.name,
    });
    as(SARA);
    expect((await projectSettings.getIntegration(ACQ))!.ingestion.createdBy).toEqual({
      id: LAURA,
      name: laura.name,
    });
    // R-G5: una persona che chi guarda non vede non ha nome (né id).
    const hidden = PEOPLE.find((p) => !visiblePeopleFor(SARA).has(p.id))!;
    state.projectSettings.get(ACQ)!.ingestion.createdById = hidden.id;
    expect((await projectSettings.getIntegration(ACQ))!.ingestion.createdBy).toBeNull();
  });

  it("rigenerare di nuovo invalida il valore di prima", async () => {
    as(LAURA);
    markReauthenticated(LAURA);
    const first = (await projectSettings.regenerateIngestionKey(ACQ)) as { key: string };
    const second = (await projectSettings.regenerateIngestionKey(ACQ)) as { key: string };
    expect(second.key).not.toBe(first.key);
    expect(secretValues("ingestion_key")).toEqual([second.key]);
    expect(entries("project.ingestion_key_regenerated")).toHaveLength(2);
  });

  it("senza riconferma → reauth_required; senza il permesso → forbidden; niente cambia", async () => {
    as(LAURA);
    const before = JSON.stringify(state.projectSettings.get(ACQ));
    expect(await projectSettings.regenerateIngestionKey(ACQ)).toEqual({
      ok: false,
      error: "reauth_required",
    });
    as(SARA);
    markReauthenticated(SARA);
    expect(await projectSettings.regenerateIngestionKey(ACQ)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(JSON.stringify(state.projectSettings.get(ACQ))).toBe(before);
    expect(secretValues("ingestion_key")).toEqual([]);
    expect(entries()).toHaveLength(0);
  });
});

describe("la rigenerazione del secret del webhook git", () => {
  it("il valore esce una volta; poi solo le ultime 4; il vecchio è dimenticato", async () => {
    as(LAURA);
    markReauthenticated(LAURA);
    const first = (await projectSettings.regenerateWebhookSecret("repo-acq")) as {
      ok: true;
      secret: string;
    };
    expect(first.ok).toBe(true);
    expect(first.secret).toMatch(/^[0-9a-f]{40}$/);
    const view = (await projectSettings.getIntegration(ACQ))!;
    expect(view.gitWebhooks[0]!.secretLast4).toBe(first.secret.slice(-4));
    expect(JSON.stringify(view)).not.toContain(first.secret);
    const second = (await projectSettings.regenerateWebhookSecret("repo-acq")) as {
      secret: string;
    };
    expect(secretValues("git_webhook_secret")).toEqual([second.secret]);
    expect(JSON.stringify(state.changelog)).not.toContain(second.secret);
    expect(entries("repository.webhook_secret_regenerated")).toHaveLength(2);
    expect(entries("repository.webhook_secret_regenerated")[0]).toMatchObject({
      projectId: ACQ,
      object: { type: "repository", id: "repo-acq", label: "portale-utenti" },
    });
  });

  it("con repos.manage senza project.settings.manage si rigenera il secret, non la chiave", async () => {
    as(SARA);
    grantProjectPermission(SARA, ACQ, "repos.manage" as never);
    markReauthenticated(SARA);
    const view = (await projectSettings.getIntegration(ACQ))!;
    expect(view.canRegenerateKey).toBe(false);
    expect(view.gitWebhooks[0]!.canRegenerate).toBe(true);
    expect(await projectSettings.regenerateWebhookSecret("repo-acq")).toMatchObject({ ok: true });
  });

  it("senza riconferma → reauth_required; senza repos.manage → forbidden; invisibile → not_found", async () => {
    as(LAURA);
    expect(await projectSettings.regenerateWebhookSecret("repo-acq")).toEqual({
      ok: false,
      error: "reauth_required",
    });
    as(SARA);
    markReauthenticated(SARA);
    expect(await projectSettings.regenerateWebhookSecret("repo-acq")).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await projectSettings.regenerateWebhookSecret("repo-aud")).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(secretValues("git_webhook_secret")).toEqual([]);
    expect(entries()).toHaveLength(0);
  });
});
