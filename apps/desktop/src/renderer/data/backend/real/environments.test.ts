import { ApiError } from "@stubwise/api-client";
import { projectEnvironmentSchema } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { createRealEnvironments, type EnvironmentsApi } from "./environments";

// Area 8, F4a: gli ambienti sulle rotte di F1. La riga «tutto il progetto»
// del prototipo è il `serverId` dell'ambiente; i server si nominano per codice
// e si mandano per id, fra quelli che chi scrive vede (S3).

const PRJ = "11111111-1111-4111-8111-111111111111";
const ENV = "22222222-2222-4222-8222-222222222222";
const R_APP = "33333333-3333-4333-8333-333333333333";
const R_ADMIN = "44444444-4444-4444-8444-444444444444";
const SRV3 = "55555555-5555-4555-8555-555555555555";
const SRV4 = "66666666-6666-4666-8666-666666666666";
const NOW = "2026-11-14T12:00:00.000Z";

const env = (over: Record<string, unknown> = {}) =>
  projectEnvironmentSchema.parse({
    id: ENV,
    projectId: PRJ,
    name: "Production",
    kind: "production",
    url: null,
    serverId: SRV3,
    serverCode: "SRV-3",
    createdAt: NOW,
    updatedAt: NOW,
    // Il server stende il server di tutto il progetto su ogni repository; audin-admin ha il suo.
    servers: [
      {
        repositoryId: R_APP,
        serverId: SRV3,
        serverCode: "SRV-3",
        reportedSha: "f2a4c6e",
        reportedAt: NOW,
        releaseCode: "AUD-V2",
        containers: ["audin-app", "audin-worker"],
      },
      {
        repositoryId: R_ADMIN,
        serverId: SRV4,
        serverCode: "SRV-4",
        reportedSha: null,
        reportedAt: null,
        releaseCode: null,
      },
    ],
    canManage: true,
    onlyHere: [SRV4],
    ...over,
  });

const calls: unknown[][] = [];

function fakeApi(over: Partial<EnvironmentsApi> = {}): EnvironmentsApi {
  calls.length = 0;
  return {
    list: async () => [env()],
    repositories: async () => [
      { id: R_APP, name: "audin-app" },
      { id: R_ADMIN, name: "audin-admin" },
    ],
    servers: async () => [
      { id: SRV3, code: "SRV-3" },
      { id: SRV4, code: "SRV-4" },
    ],
    canManage: async () => false,
    create: async (projectId, body) => {
      calls.push(["create", projectId, body]);
      return env({ name: body.name });
    },
    update: async (projectId, id, patch) => {
      calls.push(["update", projectId, id, patch]);
      return env();
    },
    remove: async (projectId, id) => {
      calls.push(["remove", projectId, id]);
    },
    setContainers: async (projectId, id, body) => {
      calls.push(["setContainers", projectId, id, body]);
      return body;
    },
    ...over,
  };
}

describe("gli ambienti dal server (area 8, F4a)", () => {
  it("la riga di tutto il progetto è il `serverId`; le eccezioni per repository; onlyHere per codice", async () => {
    const list = await createRealEnvironments(fakeApi()).listEnvironments(PRJ);
    expect(list.canManage).toBe(true);
    expect(list.onlyHere).toEqual(["SRV-4"]);
    expect(list.repositories).toEqual([
      { id: R_APP, name: "audin-app" },
      { id: R_ADMIN, name: "audin-admin" },
    ]);
    expect(list.environments[0]!.servers).toEqual([
      {
        repositoryId: null,
        serverCode: "SRV-3",
        reportedSha: "f2a4c6e",
        reportedAt: NOW,
        releaseCode: "AUD-V2",
        containers: ["audin-app", "audin-worker"],
      },
      {
        repositoryId: R_ADMIN,
        serverCode: "SRV-4",
        reportedSha: null,
        reportedAt: null,
        releaseCode: null,
        containers: [],
      },
    ]);
  });

  it("senza ambienti, `environments.manage` lo dice la sessione", async () => {
    const api = fakeApi({ list: async () => [], canManage: async () => true });
    expect((await createRealEnvironments(api).listEnvironments(PRJ)).canManage).toBe(true);
  });

  it("creare: codici → id dei server visibili, tutto il progetto → `serverId`", async () => {
    const envs = createRealEnvironments(fakeApi());
    await envs.createEnvironment(PRJ, {
      name: " Staging ",
      kind: "staging",
      url: null,
      servers: [
        { repositoryId: null, serverCode: "srv-3" },
        { repositoryId: R_ADMIN, serverCode: "SRV-4" },
      ],
    });
    expect(calls).toEqual([
      [
        "create",
        PRJ,
        {
          name: "Staging",
          kind: "staging",
          url: null,
          serverId: SRV3,
          servers: [{ repositoryId: R_ADMIN, serverId: SRV4 }],
        },
      ],
    ]);
  });

  it("un server che chi scrive non vede è `invalid: serverCode`, prima di scrivere; anche dal server (422)", async () => {
    const envs = createRealEnvironments(fakeApi());
    await expect(
      envs.createEnvironment(PRJ, {
        name: "x",
        kind: "test",
        url: null,
        servers: [{ repositoryId: null, serverCode: "SRV-9" }],
      }),
    ).rejects.toThrow("invalid: serverCode");
    expect(calls).toEqual([]);
    const refused = createRealEnvironments(
      fakeApi({
        create: async () => {
          throw new ApiError(422, "server_not_visible", "server_not_visible");
        },
      }),
    );
    await expect(
      refused.createEnvironment(PRJ, {
        name: "x",
        kind: "test",
        url: null,
        servers: [{ repositoryId: null, serverCode: "SRV-3" }],
      }),
    ).rejects.toThrow("invalid: serverCode");
  });

  it("modificare: il tipo non cambia; una repository che perde il suo server torna a quello di tutto il progetto", async () => {
    const envs = createRealEnvironments(fakeApi());
    await envs.listEnvironments(PRJ);
    await expect(envs.updateEnvironment(ENV, { kind: "staging" })).rejects.toThrow("invalid: kind");
    await envs.updateEnvironment(ENV, { servers: [{ repositoryId: null, serverCode: "SRV-3" }] });
    expect(calls).toEqual([
      [
        "update",
        PRJ,
        ENV,
        { serverId: SRV3, servers: [{ repositoryId: R_ADMIN, serverId: SRV3 }] },
      ],
    ]);
  });

  it("review F4a, I2: un Lead che non vede il server rinomina l'ambiente: si manda solo il nome", async () => {
    const envs = createRealEnvironments(fakeApi({ servers: async () => [] }));
    await envs.listEnvironments(PRJ);
    await envs.updateEnvironment(ENV, { name: "Prod" });
    expect(calls).toEqual([["update", PRJ, ENV, { name: "Prod" }]]);
  });

  it("togliere usa il progetto dell'ambiente; uno mai letto è not_found", async () => {
    const envs = createRealEnvironments(fakeApi());
    await expect(envs.deleteEnvironment(ENV)).rejects.toThrow("not_found");
    await envs.listEnvironments(PRJ);
    expect(await envs.deleteEnvironment(ENV)).toEqual({ ok: true });
    expect(calls).toEqual([["remove", PRJ, ENV]]);
  });

  it("F5: un ambiente con file d'ambiente, senza riconferma → reauth_required, l'ambiente resta noto", async () => {
    let first = true;
    const envs = createRealEnvironments(
      fakeApi({
        remove: async () => {
          if (first) {
            first = false;
            throw new ApiError(403, "reauth", "reauth_required");
          }
        },
      }),
    );
    await envs.listEnvironments(PRJ);
    expect(await envs.deleteEnvironment(ENV)).toEqual({ ok: false, error: "reauth_required" });
    // Riconfermata, la stessa chiamata riparte (useReauth) e trova l'ambiente.
    expect(await envs.deleteEnvironment(ENV)).toEqual({ ok: true });
  });

  it("R0-D: i container per riga; la riga di tutto il progetto li prende dalle sue repository", async () => {
    const list = await createRealEnvironments(fakeApi()).listEnvironments(PRJ);
    expect(list.environments[0]!.servers.map((s) => s.containers)).toEqual([
      ["audin-app", "audin-worker"],
      [],
    ]);
  });

  it("R0-D: scrivere i container: codice → id del server dell'ambiente; gli errori nelle parole del prototipo", async () => {
    const envs = createRealEnvironments(fakeApi());
    await envs.listEnvironments(PRJ);
    expect(
      await envs.setEnvironmentContainers(ENV, { serverCode: "srv-4", containers: ["redis"] }),
    ).toEqual({ serverCode: "SRV-4", containers: ["redis"] });
    expect(calls).toEqual([["setContainers", PRJ, ENV, { serverId: SRV4, containers: ["redis"] }]]);
    // Un server che l'ambiente non usa: prima di scrivere.
    await expect(
      envs.setEnvironmentContainers(ENV, { serverCode: "SRV-9", containers: [] }),
    ).rejects.toThrow("invalid: server_not_in_environment");
    const refused = createRealEnvironments(
      fakeApi({
        setContainers: async () => {
          throw new ApiError(409, "conflict", "container_of_other_project");
        },
      }),
    );
    await refused.listEnvironments(PRJ);
    await expect(
      refused.setEnvironmentContainers(ENV, { serverCode: "SRV-3", containers: ["redis"] }),
    ).rejects.toThrow("invalid: container_of_other_project");
  });
});
