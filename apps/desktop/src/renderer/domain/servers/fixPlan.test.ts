import { validateServerPlan } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { actionKey, prunes } from "./fixPlan";

// Il piano di correzione di un server (area 8, F4b): SOLO azioni dell'insieme
// chiuso (`serverPlanSchema` di `@stubwise/shared`), 1–10 passi, ognuno col
// perché; i container sono quelli che l'agente riporta, del progetto
// attribuito (i container dei suoi ambienti, R0-D) e di nessun altro. La
// regola è `validateServerPlan` di `@stubwise/shared`, la stessa del server:
// il prototipo la USA, e qui la si fissa nei casi che il prototipo esercita.
// «Libera spazio» si può su ogni server (F4b-8 = c): su un server condiviso
// lo si DICE prima dell'approvazione (`prunes`).

const ctx = {
  projectId: "p1",
  serverProjects: [
    {
      projectId: "p1",
      projectCode: "P1",
      environments: [{ name: "Production", containers: ["api", "postgres"] }],
    },
    {
      projectId: "p2",
      projectCode: "P2",
      environments: [{ name: "Production", containers: ["web"] }],
    },
  ],
  seenContainers: ["api", "postgres", "web", "cache"],
};
const checkProposedPlan = (plan: unknown, c: typeof ctx) => validateServerPlan({ plan, ...c });
const restart = (container = "api") => ({
  action: "container.restart" as const,
  params: { container, timeoutSeconds: 30 },
  why: "It is stuck.",
});

describe("validateServerPlan, come lo usa il prototipo", () => {
  it("un piano dell'insieme chiuso passa, e torna validato", () => {
    const r = checkProposedPlan(
      {
        steps: [
          restart(),
          { action: "docker.prune", params: { what: "build_cache" }, why: "The disk is full." },
        ],
      },
      ctx,
    );
    expect(r).toEqual({
      ok: true,
      plan: {
        steps: [
          restart(),
          { action: "docker.prune", params: { what: "build_cache" }, why: "The disk is full." },
        ],
      },
    });
  });

  it("un'azione fuori dall'insieme, o una lettura, non è un piano", () => {
    for (const action of [
      "image.pull",
      "container.exec",
      "container.create",
      "compose.up",
      "deploy",
      "container.logs",
      "container.state",
    ])
      expect(
        checkProposedPlan({ steps: [{ action, params: { container: "api" }, why: "x" }] }, ctx),
        action,
      ).toEqual({ ok: false, reason: "schema", step: null });
  });

  it("un comando libero, un parametro in più o una stringa di shell: rifiutati", () => {
    const bad = [
      { steps: [{ action: "container.restart", params: { container: "api" }, why: "x" }] },
      {
        steps: [
          { action: "container.start", params: { container: "api", cmd: "rm -rf /" }, why: "x" },
        ],
      },
      { steps: [{ action: "container.start", params: { container: "api;reboot" }, why: "x" }] },
      { steps: [{ action: "container.start", params: { container: "api" } }] },
      { steps: [{ action: "docker.prune", params: { what: "volumes" }, why: "x" }] },
      { steps: [], command: "docker system prune -af" },
      { steps: Array.from({ length: 11 }, () => restart()) },
      { steps: [] },
      "sudo docker restart api",
    ];
    for (const plan of bad)
      expect(checkProposedPlan(plan, ctx).ok, JSON.stringify(plan)).toBe(false);
  });

  it("un container che l'agente non riporta, di un altro progetto o di nessuno: rifiutato col passo", () => {
    expect(checkProposedPlan({ steps: [restart(), restart("ghost")] }, ctx)).toEqual({
      ok: false,
      reason: "unknown_container",
      step: 1,
    });
    expect(checkProposedPlan({ steps: [restart("web")] }, ctx)).toEqual({
      ok: false,
      reason: "container_of_other_project",
      step: 0,
    });
    // Visto sul server ma non legato al progetto attribuito (R0-D).
    expect(checkProposedPlan({ steps: [restart("cache")] }, ctx)).toEqual({
      ok: false,
      reason: "container_not_of_project",
      step: 0,
    });
  });
});

describe("prunes e actionKey", () => {
  it("dice se il piano libera spazio (tocca tutto il server)", () => {
    expect(prunes({ steps: [restart()] })).toBe(false);
    expect(
      prunes({
        steps: [
          restart(),
          { action: "docker.prune" as const, params: { what: "images_unused" as const }, why: "x" },
        ],
      }),
    ).toBe(true);
  });

  it("la chiave dell'etichetta di un'azione (i18n non vuole punti nelle chiavi)", () => {
    expect(actionKey("container.restart")).toBe("container_restart");
    expect(actionKey("docker.prune")).toBe("docker_prune");
  });
});
