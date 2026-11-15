import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serverProjectsOf } from "../../domain/servers/projects";
import { createProject, releases, resetApi, setLatency } from "../api";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { setSessionPersonId } from "../session";
import { state, visibleProjectIds } from "../store";
import { can, viewerFor } from "../viewer";

// Area 8, F4b (R0-D, R7): i container di un ambiente su uno dei suoi server
// (PUT …/environments/:id/containers sul server). Dicono quale progetto
// possiede un container: l'attribuzione di un guasto e il piano di
// correzione si reggono su di loro. Solo nomi che l'agente riporta per quel
// server, mai di un altro progetto; una riga riscritta con lo stesso server
// li tiene.

const ACQ = "prj-acq";
const as = (personId: string) => setSessionPersonId(personId);
const message = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error) => e.message,
  );
const acqProd = () => state.environments.find((e) => e.id === "env-acq-prod")!;
const outsider = () =>
  PEOPLE.find((p) => p.id !== CLAUDE_ID && !visibleProjectIds(p.id).has(ACQ))!.id;
const codeOf = (id: string) => state.projectsById.get(id)!.code;

beforeEach(() => {
  resetApi();
  setLatency(0);
  as("p-roberta");
});
afterEach(() => resetApi());

/** Un secondo progetto con la produzione su SRV-1. */
async function secondOnSrv1() {
  const other = await createProject({ code: "SRVX", name: "Second", template: "software" });
  const env = await releases.createEnvironment(other.id, {
    name: "Production",
    kind: "production",
    url: null,
    servers: [{ repositoryId: null, serverCode: "SRV-1" }],
  });
  return { other, env };
}

describe("i container di un ambiente (R0-D)", () => {
  it("il seme: la produzione di ACQ possiede i container dell'app su SRV-1", () => {
    expect(acqProd().servers[0]!.containers).toEqual([
      "portale-web",
      "portale-api",
      "portale-import",
      "postgres",
    ]);
  });

  it("si scrivono per server, su ogni riga dell'ambiente con quel server, senza doppioni", async () => {
    const saved = await releases.setEnvironmentContainers("env-acq-prod", {
      serverCode: "SRV-1",
      containers: ["portale-api", "portale-api", "postgres"],
    });
    expect(saved).toEqual({ serverCode: "SRV-1", containers: ["portale-api", "postgres"] });
    expect(acqProd().servers[0]!.containers).toEqual(["portale-api", "postgres"]);
  });

  it("serverProjectsOf li legge: l'attribuzione si regge su di loro", () => {
    expect(serverProjectsOf("SRV-1", state.environments, codeOf)).toEqual([
      {
        projectId: ACQ,
        projectCode: "ACQ",
        environments: [
          {
            name: "Production",
            containers: ["portale-web", "portale-api", "portale-import", "postgres"],
          },
        ],
      },
    ]);
  });

  it("un container che l'agente non riporta, o un server che l'ambiente non usa: rifiutati, niente scritto", async () => {
    const before = structuredClone(acqProd().servers);
    expect(
      await message(
        releases.setEnvironmentContainers("env-acq-prod", {
          serverCode: "SRV-1",
          containers: ["ghost"],
        }),
      ),
    ).toBe("invalid: unknown_container");
    expect(
      await message(
        releases.setEnvironmentContainers("env-acq-prod", {
          serverCode: "SRV-2",
          containers: [],
        }),
      ),
    ).toBe("invalid: server_not_in_environment");
    expect(acqProd().servers).toEqual(before);
  });

  it("un container già di un altro progetto sullo stesso server: `container_of_other_project`", async () => {
    const { env } = await secondOnSrv1();
    expect(
      await message(
        releases.setEnvironmentContainers(env.id, {
          serverCode: "SRV-1",
          containers: ["postgres"],
        }),
      ),
    ).toBe("invalid: container_of_other_project");
    // Uno libero sì.
    await releases.setEnvironmentContainers(env.id, { serverCode: "SRV-1", containers: ["caddy"] });
    expect(state.environments.find((e) => e.id === env.id)!.servers[0]!.containers).toEqual([
      "caddy",
    ]);
  });

  it("72, review: un container col NOME di un ambiente di un altro progetto senza container è suo", async () => {
    const { env } = await secondOnSrv1();
    // L'altro ambiente non ha container: vale il suo nome; rinominato come un container di SRV-1.
    state.environments.find((e) => e.id === env.id)!.name = "caddy";
    expect(
      await message(
        releases.setEnvironmentContainers("env-acq-prod", {
          serverCode: "SRV-1",
          containers: ["caddy"],
        }),
      ),
    ).toBe("invalid: container_of_other_project");
  });

  it("chi non ha environments.manage: forbidden; un ambiente invisibile: not_found", async () => {
    // Chi legge ACQ senza poterne gestire gli ambienti.
    as(
      PEOPLE.find(
        (p) =>
          p.id !== CLAUDE_ID &&
          visibleProjectIds(p.id).has(ACQ) &&
          !can(viewerFor(p.id), "environments.manage", ACQ),
      )!.id,
    );
    expect(
      await message(
        releases.setEnvironmentContainers("env-acq-prod", { serverCode: "SRV-1", containers: [] }),
      ),
    ).toBe("forbidden");
    as(outsider());
    expect(
      await message(
        releases.setEnvironmentContainers("env-acq-prod", { serverCode: "SRV-1", containers: [] }),
      ),
    ).toBe("not_found");
  });

  it("una riga riscritta con lo STESSO server li tiene; cambiando server ripartono vuoti", async () => {
    await releases.updateEnvironment("env-acq-prod", {
      name: "Prod",
      servers: [{ repositoryId: null, serverCode: "SRV-1" }],
    });
    expect(acqProd().servers[0]!.containers).toHaveLength(4);
    await releases.updateEnvironment("env-acq-prod", {
      servers: [{ repositoryId: null, serverCode: "SRV-4" }],
    });
    expect(acqProd().servers[0]!.containers ?? []).toEqual([]);
  });
});
