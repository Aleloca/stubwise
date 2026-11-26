import { describe, expect, it } from "vitest";
import {
  attributeServerCause,
  canonicalCommandPayload,
  CONTAINER_NAME_RE,
  serverActionSchema,
  serverAnalysisLimitsSchema,
  serverPlanSchema,
  SERVER_ACTIONS,
  sshReadSchema,
  SSH_READS,
  type AttributionInput,
} from "./operations.js";

// Area 8, F4b: l'insieme CHIUSO delle azioni sui server, la serializzazione
// canonica di un comando firmato, le letture SSH, i tetti dell'analisi e
// l'attribuzione del guasto a un progetto. Le regole: CLAUDE.md «Stubwise non
// fa deploy» e docs/invariants/server-operations.md.

describe("SERVER_ACTIONS: l'insieme chiuso", () => {
  it("esattamente queste azioni, coi loro tipi; nient'altro", () => {
    expect(Object.fromEntries(SERVER_ACTIONS.map((a) => [a.action, a.kind]))).toEqual({
      "container.restart": "change",
      "container.stop": "change",
      "container.start": "change",
      "docker.prune": "change",
      "container.logs": "read",
      "container.state": "read",
    });
  });

  it("i parametri validati: container per nome, numeri nei limiti, prune solo coi tre valori", () => {
    expect(serverActionSchema.parse({ action: "container.restart", params: { container: "web", timeoutSeconds: 10 } })).toBeTruthy();
    expect(serverActionSchema.safeParse({ action: "container.restart", params: { container: "web", timeoutSeconds: 999 } }).success).toBe(false);
    expect(serverActionSchema.safeParse({ action: "container.logs", params: { container: "web", lines: 501, sinceMinutes: 10 } }).success).toBe(false);
    for (const what of ["images_unused", "build_cache", "stopped_containers"]) {
      expect(serverActionSchema.safeParse({ action: "docker.prune", params: { what } }).success).toBe(true);
    }
    expect(serverActionSchema.safeParse({ action: "docker.prune", params: { what: "volumes" } }).success).toBe(false);
  });

  it("NEGATIVO: ogni azione che rilascia o esegue è fuori, e nessuna stringa di shell passa come container", () => {
    for (const action of ["image.pull", "container.create", "container.recreate", "compose.up", "compose.down", "container.exec", "container.run", "host.exec", "shell"]) {
      expect(serverActionSchema.safeParse({ action, params: {} }).success, action).toBe(false);
    }
    for (const container of ["web; rm -rf /", "web && curl x", "$(id)", "../etc", "a/b", "-web", "", "w".repeat(200), "web\nx"]) {
      expect(serverActionSchema.safeParse({ action: "container.restart", params: { container, timeoutSeconds: 10 } }).success, container).toBe(false);
      expect(CONTAINER_NAME_RE.test(container), container).toBe(false);
    }
    // Parametri in più (un campo `cmd` nascosto) rifiutati.
    expect(serverActionSchema.safeParse({ action: "container.start", params: { container: "web", cmd: "sh" } }).success).toBe(false);
  });

  it("un piano: solo azioni che CAMBIANO, da 1 a 10 passi, ognuno col suo perché", () => {
    const step = { action: "container.start", params: { container: "web" }, why: "è fermo" };
    expect(serverPlanSchema.parse({ steps: [step] }).steps).toHaveLength(1);
    expect(serverPlanSchema.safeParse({ steps: [] }).success).toBe(false);
    expect(serverPlanSchema.safeParse({ steps: Array.from({ length: 11 }, () => step) }).success).toBe(false);
    expect(serverPlanSchema.safeParse({ steps: [{ action: "container.logs", params: { container: "web", lines: 10, sinceMinutes: 5 }, why: "x" }] }).success).toBe(false);
  });
});

describe("canonicalCommandPayload: la firma copre ogni campo, in un ordine solo", () => {
  const base = {
    v: 1 as const,
    serverId: "s1",
    commandId: "c1",
    action: "container.restart",
    params: { timeoutSeconds: 10, container: "web" },
    approvalId: "a1",
    issuedAt: "2026-11-14T10:00:00.000Z",
    expiresAt: "2026-11-14T10:10:00.000Z",
  };
  it("chiavi ordinate a ogni livello, nessuno spazio: lo stesso comando dà la stessa stringa", () => {
    const a = canonicalCommandPayload(base);
    const b = canonicalCommandPayload({ ...base, params: { container: "web", timeoutSeconds: 10 } });
    expect(a).toBe(b);
    expect(a).toBe('{"action":"container.restart","approvalId":"a1","commandId":"c1","expiresAt":"2026-11-14T10:10:00.000Z","issuedAt":"2026-11-14T10:00:00.000Z","params":{"container":"web","timeoutSeconds":10},"serverId":"s1","v":1}');
  });
  it("cambiare UN campo cambia la stringa", () => {
    const a = canonicalCommandPayload(base);
    for (const over of [{ serverId: "s2" }, { commandId: "c2" }, { action: "container.stop" }, { approvalId: null }, { expiresAt: "2026-11-14T11:00:00.000Z" }, { params: { container: "db", timeoutSeconds: 10 } }]) {
      expect(canonicalCommandPayload({ ...base, ...over })).not.toBe(a);
    }
  });
});

describe("SSH_READS: argv fissi, parametri solo numerici", () => {
  it("l'elenco chiuso", () => {
    expect(SSH_READS.map((r) => r.read).sort()).toEqual(["disk", "failed_units", "journal_errors", "listening", "load", "memory", "processes", "uptime"]);
  });
  it("NEGATIVO: nessuna lettura fuori elenco, nessun parametro testuale", () => {
    expect(sshReadSchema.safeParse({ read: "cat", params: { path: "/etc/shadow" } }).success).toBe(false);
    expect(sshReadSchema.safeParse({ read: "processes", params: { top: "10; rm" } }).success).toBe(false);
    expect(sshReadSchema.safeParse({ read: "journal_errors", params: { lines: 201 } }).success).toBe(false);
    expect(sshReadSchema.parse({ read: "processes", params: { top: 10 } })).toBeTruthy();
  });
  it("gli argv sono costanti, coi soli numeri sostituiti", () => {
    const p = SSH_READS.find((r) => r.read === "processes")!;
    expect(p.argv({ top: 7 })).toEqual(["ps", "-eo", "pid,user,pcpu,pmem,etime,comm", "--sort=-pcpu"]);
    const j = SSH_READS.find((r) => r.read === "journal_errors")!;
    expect(j.argv({ lines: 50 })).toEqual(["journalctl", "-p", "err", "-n", "50", "--no-pager"]);
    expect(j.needsJournalGroup).toBe(true);
  });
});

describe("serverAnalysisLimitsSchema: i tetti di Impostazioni (F4b-2)", () => {
  it("i default e i limiti", () => {
    expect(serverAnalysisLimitsSchema.parse({})).toEqual({ enabled: true, maxMinutes: 10, maxCostUsd: 1, maxAgentReads: 30, maxSshReads: 30 });
    for (const bad of [{ maxMinutes: 0 }, { maxMinutes: 61 }, { maxCostUsd: 0.05 }, { maxCostUsd: 21 }, { maxAgentReads: 201 }, { maxSshReads: -1 }]) {
      expect(serverAnalysisLimitsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("attributeServerCause: QUALE progetto causa il guasto (F4b-4), validato", () => {
  // Server condiviso: ACQ ha l'ambiente «production» col container acq-web;
  // AUD ha «staging» col container aud-api; un container «production» per
  // nome (la regola di fase 8, lista vuota) di AUD.
  const shared: AttributionInput["serverProjects"] = [
    { projectId: "p-acq", projectCode: "ACQ", environments: [{ name: "production", containers: ["acq-web", "acq-worker"] }] },
    { projectId: "p-aud", projectCode: "AUD", environments: [{ name: "staging", containers: ["aud-api"] }, { name: "aud-legacy", containers: [] }] },
  ];
  const seen = ["acq-web", "acq-worker", "aud-api", "aud-legacy", "postgres"];
  const attr = (cause: AttributionInput["cause"], serverProjects = shared) => attributeServerCause({ serverProjects, seenContainers: seen, cause });

  it("progetto giusto coi suoi container → attribuito", () => {
    expect(attr({ projectCode: "ACQ", containers: ["acq-web"] })).toEqual({ kind: "attributed", projectId: "p-acq", projectCode: "ACQ" });
    // La regola per nome quando la lista dell'ambiente è vuota.
    expect(attr({ projectCode: "AUD", containers: ["aud-legacy"] })).toMatchObject({ kind: "attributed", projectId: "p-aud" });
  });

  it("NEGATIVO: spinto verso un altro progetto coi container di un altro → non determinato", () => {
    expect(attr({ projectCode: "AUD", containers: ["acq-web"] })).toMatchObject({ kind: "undetermined", reason: "containers_of_other_project" });
    expect(attr({ projectCode: "AUD", containers: ["aud-api", "acq-web"] })).toMatchObject({ kind: "undetermined", reason: "containers_of_other_project" });
  });

  it("NEGATIVO: un progetto che non usa il server, nessun container, un container mai visto, un container di nessuno → non determinato", () => {
    expect(attr({ projectCode: "XYZ", containers: ["acq-web"] })).toMatchObject({ kind: "undetermined", reason: "project_not_on_server" });
    expect(attr({ projectCode: "ACQ", containers: [] })).toMatchObject({ kind: "undetermined", reason: "no_containers" });
    expect(attr({ projectCode: "ACQ", containers: ["acq-web", "fantasma"] })).toMatchObject({ kind: "undetermined", reason: "unknown_container" });
    expect(attr({ projectCode: "ACQ", containers: ["postgres"] })).toMatchObject({ kind: "undetermined", reason: "no_container_of_project" });
    expect(attr({ projectCode: null, containers: ["acq-web"] })).toMatchObject({ kind: "undetermined", reason: "no_project" });
  });

  it("un server di UN solo progetto: quel progetto, anche senza codice; ma mai con un container mai visto", () => {
    const one = [shared[0]!];
    expect(attr({ projectCode: null, containers: ["postgres"] }, one)).toMatchObject({ kind: "attributed", projectId: "p-acq" });
    expect(attr({ projectCode: "AUD", containers: ["acq-web"] }, one)).toMatchObject({ kind: "undetermined", reason: "project_not_on_server" });
    expect(attr({ projectCode: null, containers: ["fantasma"] }, one)).toMatchObject({ kind: "undetermined", reason: "unknown_container" });
  });
});

describe("readServerAnalysisLimits: i tetti salvati, o i default", () => {
  it("null o corrotti → i default; parziali → completati", async () => {
    const { readServerAnalysisLimits } = await import("./operations.js");
    const D = { enabled: true, maxMinutes: 10, maxCostUsd: 1, maxAgentReads: 30, maxSshReads: 30 };
    expect(readServerAnalysisLimits(null)).toEqual(D);
    expect(readServerAnalysisLimits({ maxMinutes: "x" })).toEqual(D);
    expect(readServerAnalysisLimits({ maxMinutes: 5 })).toEqual({ ...D, maxMinutes: 5 });
  });
});

describe("gli strumenti dell'analisi (S5)", () => {
  it("nessuno strumento che cambia: solo letture più il resoconto finale", async () => {
    const { SERVER_ANALYSIS_TOOLS } = await import("./operations.js");
    expect([...SERVER_ANALYSIS_TOOLS]).toEqual([
      "server_overview",
      "server_metrics",
      "server_environments",
      "container_logs",
      "container_state",
      "ssh_read",
      "report_server_diagnosis",
    ]);
  });

  it("il resoconto: campi in più rifiutati; progetto null ammesso; al più 10 passi", async () => {
    const { serverDiagnosisReportSchema } = await import("./operations.js");
    const ok = { summary: "disco pieno", cause: { projectCode: null, containers: [], why: "" } };
    expect(serverDiagnosisReportSchema.safeParse(ok).success).toBe(true);
    expect(serverDiagnosisReportSchema.safeParse({ ...ok, command: "rm -rf /" }).success).toBe(false);
    expect(serverDiagnosisReportSchema.safeParse({ ...ok, cause: { ...ok.cause, shell: "x" } }).success).toBe(false);
    const step = { action: "container.restart", params: { container: "web" }, why: "x" };
    expect(serverDiagnosisReportSchema.safeParse({ ...ok, fix: { steps: Array(11).fill(step) } }).success).toBe(false);
    expect(serverDiagnosisReportSchema.safeParse({ ...ok, fix: { steps: [step] } }).success).toBe(true);
  });
});

describe("validateServerPlan (S6): una proposta salvabile, o perché no", () => {
  const ctx = async () => {
    const { validateServerPlan } = await import("./operations.js");
    const serverProjects = [
      { projectId: "A", projectCode: "AAA", environments: [{ name: "production", containers: ["web-a"] }] },
      { projectId: "B", projectCode: "BBB", environments: [{ name: "staging", containers: [] }] },
    ];
    const v = (plan: unknown, projectId = "A", projects = serverProjects) =>
      validateServerPlan({ plan, projectId, serverProjects: projects, seenContainers: ["web-a", "staging", "other"] });
    return { v, serverProjects };
  };
  const step = (action: string, params: object) => ({ action, params, why: "perché" });

  it("un riavvio di un container del progetto: ok", async () => {
    const { v } = await ctx();
    expect(v({ steps: [step("container.restart", { container: "web-a", timeoutSeconds: 10 })] })).toMatchObject({ ok: true });
  });

  it("NEGATIVO: fuori schema (rilascio, shell, parametro in più, lettura), container mai visto, di un altro progetto, di nessun progetto", async () => {
    const { v } = await ctx();
    expect(v({ steps: [step("image.pull", { image: "x" })] })).toMatchObject({ ok: false, reason: "schema" });
    expect(v({ steps: [step("container.restart", { container: "web-a; rm -rf /", timeoutSeconds: 10 })] })).toMatchObject({ ok: false, reason: "schema" });
    expect(v({ steps: [step("container.start", { container: "web-a", cmd: "sh" })] })).toMatchObject({ ok: false, reason: "schema" });
    expect(v({ steps: [step("container.logs", { container: "web-a", lines: 5, sinceMinutes: 5 })] })).toMatchObject({ ok: false, reason: "schema" });
    expect(v({ steps: [step("container.start", { container: "ghost" })] })).toMatchObject({ ok: false, reason: "unknown_container", step: 0 });
    // `staging` è il container di B per il nome dell'ambiente (lista vuota).
    expect(v({ steps: [step("container.restart", { container: "web-a", timeoutSeconds: 5 }), step("container.stop", { container: "staging", timeoutSeconds: 5 })] })).toMatchObject({
      ok: false,
      reason: "container_of_other_project",
      step: 1,
    });
    expect(v({ steps: [step("container.start", { container: "other" })] })).toMatchObject({ ok: false, reason: "container_not_of_project" });
  });

  it("una pulizia è ammessa su ogni server, anche condiviso (F4b-8 = c: l'avviso è nella vista)", async () => {
    const { v, serverProjects } = await ctx();
    const prune = { steps: [step("docker.prune", { what: "build_cache" })] };
    expect(v(prune)).toMatchObject({ ok: true });
    expect(v(prune, "A", [serverProjects[0]!])).toMatchObject({ ok: true });
    expect(v({ steps: [step("docker.prune", { what: "everything" })] })).toMatchObject({ ok: false, reason: "schema" });
  });
});
