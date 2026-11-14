import { ApiError } from "@stubwise/api-client";
import type { AlertSubscriptionRow, ProjectSubscriptions } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { createRealAlerts, type AlertsApi } from "./alerts";

// Area 8, F2 (R2): le iscrizioni agli avvisi sulle rotte vere
// (`/api/me/alert-subscriptions`, S5), con le firme del prototipo. Righe e
// stati li calcola il server: il client li legge, non li deduce.

const AUD = "11111111-1111-4111-8111-111111111111";
const BLD = "22222222-2222-4222-8222-222222222222";
const ZED = "33333333-3333-4333-8333-333333333333";

const row = (over: Partial<AlertSubscriptionRow> = {}): AlertSubscriptionRow => ({
  type: "release.failed",
  group: "releases",
  labelKey: "alerts.types.release_failed",
  app: true,
  phone: true,
  state: "on",
  suspendedReason: null,
  mandatory: ["merged", "task_author"],
  ...over,
});

const project = (id: string, code: string, name: string, rows = [row()]): ProjectSubscriptions => ({
  projectId: id,
  projectCode: code,
  projectName: name,
  rows,
});

function fakeApi(over: Partial<AlertsApi> = {}) {
  const calls: string[] = [];
  const api: AlertsApi = {
    list: async () => ({
      items: [
        project(ZED, "ZED", "Zed"),
        project(AUD, "AUD", "Audin"),
        project(BLD, "BLD", "Build"),
      ],
    }),
    follows: async () => ({ projectIds: [BLD] }),
    set: async (projectId, type, patch) => {
      calls.push(`set ${projectId} ${type} ${JSON.stringify(patch)}`);
      return row({ type, ...patch });
    },
    copy: async (projectId, fromProjectId) => {
      calls.push(`copy ${projectId} from ${fromProjectId}`);
      return { before: [] };
    },
    mute: async (projectId) => {
      calls.push(`mute ${projectId}`);
      return { before: [] };
    },
    ...over,
  };
  return { api, calls };
}

describe("le iscrizioni dal server (R2)", () => {
  it("una voce per progetto: i seguiti prima (i fissati del prototipo), poi per nome", async () => {
    const { api } = fakeApi();
    const projects = await createRealAlerts(api).subscriptionRows();
    expect(projects.map((p) => [p.code, p.pinned])).toEqual([
      ["BLD", true],
      ["AUD", false],
      ["ZED", false],
    ]);
    expect(projects[1]).toMatchObject({ projectId: AUD, name: "Audin" });
  });

  it("le righe come le manda il server: stato, motivi, permesso mancante", async () => {
    const { api } = fakeApi({
      list: async () => ({
        items: [
          project(AUD, "AUD", "Audin", [
            row(),
            row({
              type: "pr.analysis_issues",
              group: "prs",
              state: "suspended",
              suspendedReason: "repos.view",
              app: false,
              phone: false,
              mandatory: ["pr_author"],
            }),
          ]),
        ],
      }),
      follows: async () => ({ projectIds: [] }),
    });
    const [aud] = await createRealAlerts(api).subscriptionRows();
    expect(aud!.rows[0]).toEqual({
      type: "release.failed",
      group: "releases",
      labelKey: "alerts.types.release_failed",
      app: true,
      phone: true,
      state: "on",
      mandatory: ["merged", "task_author"],
    });
    expect(aud!.rows[1]).toMatchObject({ state: "suspended", suspendedReason: "repos.view" });
  });

  it("una riga con uno stato sconosciuto (server più nuovo) non si mostra", async () => {
    const unknown = { ...row({ type: "release.merged" }), state: "__unknown__" } as never;
    const { api } = fakeApi({
      list: async () => ({ items: [project(AUD, "AUD", "Audin", [row(), unknown])] }),
      follows: async () => ({ projectIds: [] }),
    });
    const [aud] = await createRealAlerts(api).subscriptionRows();
    expect(aud!.rows.map((r) => r.type)).toEqual(["release.failed"]);
  });

  it("setSubscription scrive la RIGA: un kind di prima diventa il tipo della sua riga", async () => {
    const { api, calls } = fakeApi();
    const alerts = createRealAlerts(api);
    await alerts.setSubscription(AUD, "monitor.alert", { app: false });
    await alerts.setSubscription(AUD, "release.failed", { phone: true });
    expect(calls).toEqual([
      `set ${AUD} server.trouble {"app":false}`,
      `set ${AUD} release.failed {"phone":true}`,
    ]);
  });

  it("gli errori nelle parole del prototipo", async () => {
    const fail = (status: number, code: string) => async () => {
      throw new ApiError(status, code, code);
    };
    const words = async (status: number, code: string) =>
      createRealAlerts(fakeApi({ set: fail(status, code) }).api)
        .setSubscription(AUD, "release.failed", { app: true })
        .catch((e: Error) => e.message);
    expect(await words(403, "alert_suspended")).toBe("forbidden");
    expect(await words(403, "alert_mandatory_only")).toBe("forbidden");
    expect(await words(404, "not_found")).toBe("not_found");
    expect(await words(404, "alert_type_not_found")).toBe("invalid: type");
  });

  it("«Come questo progetto»: la copia sul server, e l'«Annulla» riscrive le righe di prima", async () => {
    const before = [
      row({ type: "release.failed", app: true, phone: false }),
      row({ type: "release.merged", app: false, phone: false, state: "off" }),
      row({ type: "pr.analysis_issues", state: "suspended", suspendedReason: "repos.view" }),
      row({ type: "pr.corrected", state: "mandatory" }),
    ];
    const { api, calls } = fakeApi({
      copy: async (projectId, fromProjectId) => {
        calls.push(`copy ${projectId} from ${fromProjectId}`);
        return { before };
      },
    });
    const undo = await createRealAlerts(api).copySubscriptions(BLD, AUD);
    expect(calls).toEqual([`copy ${AUD} from ${BLD}`]);
    await undo.undo();
    // Le sospese e le obbligatorie non si scrivono (il server risponderebbe 403).
    expect(calls.slice(1).sort()).toEqual([
      `set ${AUD} release.failed {"app":true,"phone":false}`,
      `set ${AUD} release.merged {"app":false,"phone":false}`,
    ]);
  });

  it("«Mute» del progetto, con l'«Annulla»", async () => {
    const { api, calls } = fakeApi({
      mute: async (projectId) => {
        calls.push(`mute ${projectId}`);
        return { before: [row({ type: "release.failed", app: true, phone: true })] };
      },
    });
    const undo = await createRealAlerts(api).muteProject(AUD);
    expect(calls).toEqual([`mute ${AUD}`]);
    await undo.undo();
    expect(calls[1]).toBe(`set ${AUD} release.failed {"app":true,"phone":true}`);
  });

  it("copia e «Mute» su un progetto invisibile: not_found", async () => {
    const notFound = async () => {
      throw new ApiError(404, "not_found", "not_found");
    };
    const alerts = createRealAlerts(fakeApi({ copy: notFound, mute: notFound }).api);
    await expect(alerts.copySubscriptions(BLD, AUD)).rejects.toThrow("not_found");
    await expect(alerts.muteProject(AUD)).rejects.toThrow("not_found");
  });
});
