import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  alertTypeOf,
  isCatalogKind,
  registerAlertTypes,
  type AlertType,
} from "../../domain/alerts/catalog";
import { isReadCommand } from "../../domain/servers/commands";
import { ANALYSIS_MAX_COST_USD, ANALYSIS_MAX_MINUTES } from "../../domain/servers/limits";
import { whyReceives } from "../alerts/visibility";
import {
  alerts,
  createProject,
  failNext,
  listNotifications,
  releases,
  resetApi,
  servers,
  setLatency,
} from "../api";
import { SERVER_ALERT_NOTIFICATIONS } from "../seed/servers/alerts";
import { setSessionPersonId } from "../session";
import { eventsOf, setStreamLatency, state } from "../store";
import type { AppNotification, ConversationEvent, ServerAnalysis } from "../types";
import { raiseEpisode, whenAnalysesIdle } from "./analysis";

const ACQ = "prj-acq";
const as = (personId: string) => setSessionPersonId(personId);
const message = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error) => e.message,
  );

/** Le analisi nate nel test (quelle del seme non hanno `-new-` nell'id). */
const newAnalyses = (code?: string): ServerAnalysis[] =>
  state.serverAnalyses.filter((a) => a.id.includes("-new-") && (!code || a.serverCode === code));
const onlyAnalysis = (code: string): ServerAnalysis => {
  const all = newAnalyses(code);
  expect(all).toHaveLength(1);
  return all[0]!;
};
const sessionOf = (a: ServerAnalysis) =>
  state.conversations.find((c) => c.id === a.conversationId)!;
const actionsOf = (conversationId: string) =>
  eventsOf(conversationId).filter(
    (e): e is Extract<ConversationEvent, { type: "action" }> => e.type === "action",
  );
const taskOf = (a: ServerAnalysis) => state.tasksById.get(a.taskId!)!;
/** Gli avvisi pubblicati nel test, di un kind e di un server. */
const published = (kind: string, code: string): AppNotification[] =>
  state.notifications.filter(
    (n) => n.id.startsWith("n-alert") && n.kind === kind && n.objectCode === code,
  );
const inbox = async (personId: string) => {
  as(personId);
  return listNotifications();
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Per cogliere un'analisi a metà (con lo stream rallentato a 20 ms per passo). */
const FAST = { interval: 2, timeout: 2000 };

beforeEach(() => {
  resetApi();
  setLatency(0);
  as("p-roberta");
});

afterEach(() => resetApi());

describe("allarme con l'accesso di lettura: l'analisi apre la task", () => {
  it("SRV-1 memoria: avviso in ACQ, sessione di Claude in sola lettura, task, diagnosi pronta", async () => {
    const ep = await servers.simulateServerAlert("SRV-1", "memory");
    expect(ep).toMatchObject({ serverCode: "SRV-1", severity: "trouble", recoveredAt: null });
    const [trouble] = published("server.trouble", "SRV-1");
    expect(trouble).toMatchObject({ projectId: ACQ, link: "#/p/ACQ/servers/SRV-1" });
    expect(trouble!.body).toMatch(/memory at 94%.*Claude is looking into it/);

    await whenAnalysesIdle();
    const a = onlyAnalysis("SRV-1");
    expect(a).toMatchObject({ projectId: ACQ, outcome: "diagnosed", episodeId: ep.id });
    expect(state.serverEpisodes.find((e) => e.id === ep.id)!.analysisId).toBe(a.id);

    const c = sessionOf(a);
    expect(c).toMatchObject({
      kind: "server_analysis",
      ownerId: "p-claude",
      projectId: ACQ,
      visibility: "project",
      taskId: a.taskId,
      state: "finished",
      outcome: "ok",
      analysisLimits: { maxMinutes: ANALYSIS_MAX_MINUTES, maxCostUsd: ANALYSIS_MAX_COST_USD },
    });
    expect(c.usage![0]!.costUsd).toBeLessThanOrEqual(ANALYSIS_MAX_COST_USD);
    expect(actionsOf(c.id).map((x) => x.input)).toEqual([
      "uptime",
      "free -m",
      "sudo docker stats --no-stream",
      "ps aux --sort=-%mem",
      "sudo docker logs --tail 200 postgres",
    ]);

    const task = taskOf(a);
    expect(task).toMatchObject({
      code: "ACQ-7",
      projectId: ACQ,
      type: "bug",
      assigneeId: null,
      createdById: "p-claude",
      source: "server",
      serverRef: { serverCode: "SRV-1", episodeId: ep.id },
      followerIds: [],
    });
    expect(task.description).toMatch(/\*\*Diagnosis\*\*/);
    expect(task.description).toMatch(/\*\*Proposal\*\*/);
    expect(task.description).toMatch(/nothing was changed on the server/);

    const result = eventsOf(c.id).find((e) => e.type === "work_result");
    expect(result).toMatchObject({
      kind: "server_diagnosis",
      link: `#/p/ACQ/tasks?task=${task.code}`,
    });
    const [ready] = published("server.diagnosis_ready", "SRV-1");
    expect(ready).toMatchObject({ projectId: ACQ, link: `#/p/ACQ/tasks?task=${task.code}` });
  });

  it("l'ultimo uso dell'accesso di lettura è la nuova analisi, quello di correzione non cambia", async () => {
    const fixBefore = structuredClone(state.serverAccess.get("SRV-1")!.lastUse.fix);
    await servers.simulateServerAlert("SRV-1", "cpu");
    await whenAnalysesIdle();
    const a = onlyAnalysis("SRV-1");
    const lastUse = state.serverAccess.get("SRV-1")!.lastUse;
    expect(lastUse.read!.ref).toEqual({ kind: "analysis", analysisId: a.id });
    expect(lastUse.fix).toEqual(fixBefore);
    expect((await servers.getServer("SRV-1")).access.lastUse.read!.label.kind).toBe("analysis");
  });

  it("limite di tempo: chiude `timed_out` e apre la task con ciò che ha visto", async () => {
    await servers.simulateServerAlert("SRV-1", "memory", { overrun: true });
    await whenAnalysesIdle();
    const a = onlyAnalysis("SRV-1");
    expect(a.outcome).toBe("timed_out");
    expect(sessionOf(a)).toMatchObject({ state: "finished", outcome: "timed_out" });
    expect(actionsOf(a.conversationId).length).toBeLessThan(5);
    expect(taskOf(a).description).toMatch(/Partial diagnosis.*20 minutes/);
  });
});

describe("RF 4: episodi ai bordi", () => {
  it("secondo allarme durante l'analisi: un episodio, un'analisi, una task, i due motivi", async () => {
    setStreamLatency(20);
    const first = await servers.simulateServerAlert("SRV-1", "memory");
    await vi.waitFor(() => expect(newAnalyses("SRV-1")).toHaveLength(1), FAST);
    const a = onlyAnalysis("SRV-1");
    await vi.waitFor(() => expect(actionsOf(a.conversationId).length).toBeGreaterThan(0), FAST);
    expect(a.outcome).toBe("running");

    const second = await servers.simulateServerAlert("SRV-1", "cpu");
    expect(second.id).toBe(first.id);
    expect(second.reasons.map((r) => r.kind)).toEqual(["memory", "cpu"]);
    await whenAnalysesIdle();

    expect(onlyAnalysis("SRV-1").outcome).toBe("diagnosed");
    // Nessun avviso nuovo per il secondo allarme.
    expect(published("server.trouble", "SRV-1")).toHaveLength(1);
    const tasks = state.tasks.filter((t) => t.serverRef?.episodeId === first.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.description).toMatch(/Memory on acq-prod-01.*94%/);
    expect(tasks[0]!.description).toMatch(/CPU on acq-prod-01.*97%/);
    // L'analisi in corso ha letto anche per il secondo motivo.
    expect(actionsOf(a.conversationId).map((x) => x.input)).toContain("ps aux --sort=-%cpu");
  });

  it("rientro durante l'analisi: finisce, la task lo dice, avviso di rientro", async () => {
    setStreamLatency(20);
    await servers.simulateServerAlert("SRV-1", "memory");
    await vi.waitFor(() => expect(newAnalyses("SRV-1")).toHaveLength(1), FAST);
    const a = onlyAnalysis("SRV-1");
    await vi.waitFor(() => expect(actionsOf(a.conversationId).length).toBeGreaterThan(0), FAST);

    const ep = await servers.simulateServerRecovery("SRV-1");
    expect(ep.recoveredAt).not.toBeNull();
    await whenAnalysesIdle();

    expect(a.outcome).toBe("diagnosed");
    expect(sessionOf(a)).toMatchObject({ state: "finished", outcome: "ok" });
    // Le letture rimaste non sono partite; nessuna resta «in corso».
    const actions = actionsOf(a.conversationId);
    expect(actions.length).toBeLessThan(5);
    expect(actions.every((x) => x.state !== "running")).toBe(true);
    expect(taskOf(a).description).toMatch(/\*\*Back to normal\*\*/);
    expect(published("server.recovered", "SRV-1")).toHaveLength(1);
  });

  it("rientro dopo l'analisi: il rientro si aggiunge alla task che c'è già", async () => {
    await servers.simulateServerAlert("SRV-1", "disk");
    await whenAnalysesIdle();
    const task = taskOf(onlyAnalysis("SRV-1"));
    expect(task.description).not.toMatch(/Back to normal/);
    await servers.simulateServerRecovery("SRV-1");
    expect(task.description).toMatch(
      /\n\n\*\*Back to normal\*\*, without any change from Stubwise\.$/,
    );
    // Nessuna ora scritta nel testo: si legge dall'episodio, nel fuso di chi guarda.
    expect(task.description).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("SRV-2 senza accesso: nessuna sessione, l'avviso dice che manca l'accesso", async () => {
    // Il seme ha un episodio aperto su SRV-2: un allarme in più si aggiunge, senza avvisi.
    const open = await servers.simulateServerAlert("SRV-2", "cpu");
    expect(open.id).toBe("ep-srv-2-1");
    expect(published("server.trouble", "SRV-2")).toHaveLength(0);

    await servers.simulateServerRecovery("SRV-2");
    const ep = await servers.simulateServerAlert("SRV-2", "disk");
    await whenAnalysesIdle();
    expect(ep.analysisId).toBeNull();
    expect(newAnalyses("SRV-2")).toHaveLength(0);
    expect(state.conversations.filter((c) => c.kind === "server_analysis")).toHaveLength(1);
    const [n] = published("server.trouble", "SRV-2");
    expect(n).toMatchObject({ projectId: "prj-stw" });
    expect(n!.body).toMatch(/Claude can't look into it: no SSH access\./);
  });

  it("SSH irraggiungibile: tre tentativi, task lo stesso con «not reachable»", async () => {
    await servers.simulateSshUnreachable("SRV-1", true);
    await servers.simulateServerAlert("SRV-1", "memory");
    await whenAnalysesIdle();
    const a = onlyAnalysis("SRV-1");
    expect(a.outcome).toBe("unreachable");
    expect(sessionOf(a)).toMatchObject({ state: "finished", outcome: "failed" });
    const actions = actionsOf(a.conversationId);
    expect(actions).toHaveLength(3);
    expect(
      actions.every((x) => x.state === "failed" && /Connection timed out/.test(x.result!)),
    ).toBe(true);
    const task = taskOf(a);
    expect(task.title).toMatch(/not reachable over SSH/);
    expect(task.description).toMatch(/Not reachable.*3 attempts/);
    expect(published("server.diagnosis_ready", "SRV-1")).toHaveLength(1);

    // Torna raggiungibile: l'episodio successivo si analizza di nuovo.
    await servers.simulateSshUnreachable("SRV-1", false);
    await servers.simulateServerRecovery("SRV-1");
    await servers.simulateServerAlert("SRV-1", "cpu");
    await whenAnalysesIdle();
    expect(newAnalyses("SRV-1").map((x) => x.outcome)).toEqual(["unreachable", "diagnosed"]);
  });

  it("SRV-1 anche nella produzione di un secondo progetto: task nel principale, avviso in entrambi", async () => {
    const other = await createProject({
      code: "SRVX",
      name: "Second production",
      template: "software",
    });
    await releases.createEnvironment(other.id, {
      name: "Production",
      kind: "production",
      url: null,
      servers: [{ repositoryId: null, serverCode: "SRV-1" }],
    });
    // La produzione nuova viene PRIMA di quella di ACQ: vince il principale, non il primo.
    state.environments.unshift(state.environments.pop()!);
    expect(state.environments[0]!.projectId).toBe(other.id);
    await servers.simulateServerAlert("SRV-1", "memory");
    await whenAnalysesIdle();

    expect(
      published("server.trouble", "SRV-1")
        .map((n) => n.projectId)
        .sort(),
    ).toEqual([ACQ, other.id].sort());
    const a = onlyAnalysis("SRV-1");
    expect(a.projectId).toBe(ACQ);
    expect(taskOf(a).projectId).toBe(ACQ);
    expect(state.tasks.some((t) => t.projectId === other.id && t.source === "server")).toBe(false);
    expect(published("server.diagnosis_ready", "SRV-1").map((n) => n.projectId)).toEqual([ACQ]);
  });

  it("server solo di staging: nessun avviso del catalogo, nessuna analisi (anche con l'accesso)", async () => {
    const { server } = await servers.createServer({
      name: "stw-stage-01",
      environmentId: "env-stw-staging",
    });
    await servers.linkSshAccess(server.code);
    expect((await servers.verifySshAccess(server.code)).usable.read).toBe(true);
    const before = state.notifications.length;

    const ep = await servers.simulateServerAlert(server.code, "cpu");
    await whenAnalysesIdle();
    expect(ep.analysisId).toBeNull();
    expect(newAnalyses(server.code)).toHaveLength(0);
    expect(state.notifications.length).toBe(before);
  });
});

describe("RF 3: l'analisi è in sola lettura", () => {
  it("ogni azione delle sessioni d'analisi è `server.read` con un comando di lettura", async () => {
    const reasons = ["cpu", "memory", "disk", "check", "agent_silent"] as const;
    for (const reason of reasons) {
      await servers.simulateServerAlert("SRV-1", reason);
      await whenAnalysesIdle();
      await servers.simulateServerRecovery("SRV-1");
    }
    await servers.simulateSshUnreachable("SRV-1", true);
    await servers.simulateServerAlert("SRV-1", "memory");
    await whenAnalysesIdle();
    // Un server con un servizio pm2 e senza docker (SRV-4, collegato qui).
    await servers.linkSshAccess("SRV-4");
    await servers.verifySshAccess("SRV-4");
    await servers.simulateServerAlert("SRV-4", "memory");
    await whenAnalysesIdle();

    expect(newAnalyses()).toHaveLength(reasons.length + 2);
    const sessions = state.conversations.filter((c) => c.kind === "server_analysis");
    const actions = sessions.flatMap((c) => actionsOf(c.id));
    expect(actions.length).toBeGreaterThan(20);
    for (const x of actions) {
      expect(x.tool, x.label).toBe("server.read");
      expect(isReadCommand(x.input ?? ""), x.input).toBe(true);
      // R-L5: journal e stato dei servizi senza sudo.
      expect(x.input).not.toMatch(/^sudo (journalctl|systemctl)/);
    }
    // Le etichette sono frasi: si leggono nella lingua di chi guarda.
    const fresh = newAnalyses().flatMap((a) => actionsOf(a.conversationId));
    expect(fresh.every((x) => x.labelText?.key.startsWith("claude.serverAnalysis."))).toBe(true);
  });

  it("con la lettura che scrive: nessuna analisi, e l'avviso lo dice", async () => {
    await servers.simulateSshVerifyOutcome("SRV-1", "read_writes");
    await servers.verifySshAccess("SRV-1");
    const ep = await servers.simulateServerAlert("SRV-1", "memory");
    await whenAnalysesIdle();
    expect(ep.analysisId).toBeNull();
    expect(newAnalyses("SRV-1")).toHaveLength(0);
    expect(published("server.trouble", "SRV-1")[0]!.body).toMatch(
      /read-only SSH access isn't usable/,
    );
  });

  it("raiseEpisode su un server senza accesso di lettura non tocca le chiavi né l'ultimo uso", () => {
    const before = structuredClone(state.serverAccess.get("SRV-3"));
    raiseEpisode("SRV-3", [{ kind: "cpu", valuePct: 99, thresholdPct: 95 }], "trouble");
    expect(state.serverAccess.get("SRV-3")).toEqual(before);
    expect(newAnalyses("SRV-3")).toHaveLength(0);
  });
});

describe("destinatari e catalogo", () => {
  it("Marco riceve `server.trouble` di ACQ per default; Laura e Matteo no; Claude mai (R-K5)", async () => {
    await servers.simulateServerAlert("SRV-1", "memory");
    await whenAnalysesIdle();
    const [trouble] = published("server.trouble", "SRV-1");
    const [ready] = published("server.diagnosis_ready", "SRV-1");
    expect((await inbox("p-marco")).map((n) => n.id)).toEqual(
      expect.arrayContaining([trouble!.id, ready!.id]),
    );
    for (const p of ["p-laura", "p-matteo"]) {
      const ids = (await inbox(p)).map((n) => n.id);
      expect(ids, p).not.toContain(trouble!.id);
      expect(ids, p).not.toContain(ready!.id);
    }
    const serverKinds = state.notifications.filter((n) => n.kind.startsWith("server."));
    expect(serverKinds.length).toBeGreaterThan(SERVER_ALERT_NOTIFICATIONS.length);
    for (const n of serverKinds) expect(whyReceives("p-claude", n), n.id).toBeNull();
  });

  it("gli avvisi server del seme seguono i default del catalogo (e mai Claude)", async () => {
    // La diagnosi di ACQ arriva a Marco (`servers.operate` su ACQ). R-L10:
    // ogni avviso server arriva anche al full admin, membro o no (Roberta
    // non è membro di ACQ, STW né AUD).
    const ready = SERVER_ALERT_NOTIFICATIONS.find((n) => n.kind === "server.diagnosis_ready")!;
    expect((await inbox("p-marco")).map((n) => n.id)).toContain(ready.id);
    const roberta = (await inbox("p-roberta")).map((n) => n.id);
    for (const n of SERVER_ALERT_NOTIFICATIONS) {
      expect(state.projectsById.get(n.projectId!)!.memberIds).not.toContain("p-roberta");
      expect(roberta, n.kind).toContain(n.id);
      expect(whyReceives("p-claude", n)).toBeNull();
    }
    // Iscrivendosi alla riga «server» si ricevono.
    as("p-laura");
    await alerts.setSubscription("prj-stw", "server.trouble", { app: true, phone: false });
    const trouble = SERVER_ALERT_NOTIFICATIONS.find((n) => n.kind === "server.trouble")!;
    expect(whyReceives("p-laura", trouble)).toBeNull(); // spegnere/accendere vale per il futuro
    await servers.simulateServerRecovery("SRV-2");
    expect(whyReceives("p-laura", published("server.recovered", "SRV-2")[0]!)).toBe("subscribed");
  });

  it("le Preferenze hanno una riga «server» sola, con `monitor.alert` confluito", async () => {
    as("p-marco");
    const acq = (await alerts.subscriptionRows()).find((p) => p.projectId === ACQ)!;
    const monitor = acq.rows.filter((r) => r.group === "monitor").map((r) => r.type);
    expect(monitor).toEqual(["server.trouble", "server.diagnosis_ready"]);
    expect(acq.rows.find((r) => r.type === "server.trouble")).toMatchObject({
      state: "on",
      phone: true,
    });
    expect(alertTypeOf("monitor.alert")!.sameRowAs).toBe("server.trouble");
    expect(alertTypeOf("monitor.recovered")!.sameRowAs).toBe("server.trouble");
  });

  it("`resetApi` rimette il catalogo: i tipi dei server restano, le righe di prova no", () => {
    const junk: AlertType = { ...alertTypeOf("server.trouble")!, type: "server.junk" };
    registerAlertTypes([junk]);
    expect(isCatalogKind("server.junk")).toBe(true);
    resetApi();
    expect(isCatalogKind("server.junk")).toBe(false);
    for (const kind of [
      "server.trouble",
      "server.down",
      "server.recovered",
      "server.diagnosis_ready",
    ])
      expect(isCatalogKind(kind), kind).toBe(true);
    expect(alertTypeOf("monitor.alert")!.sameRowAs).toBe("server.trouble");
  });
});

describe("generazione dello stato, errori, guardie", () => {
  it("un'analisi in corso dopo `resetApi` non scrive nello stato nuovo", async () => {
    setStreamLatency(20);
    await servers.simulateServerAlert("SRV-1", "memory");
    await vi.waitFor(() => expect(newAnalyses("SRV-1")).toHaveLength(1), FAST);
    const cid = onlyAnalysis("SRV-1").conversationId;
    await vi.waitFor(() => expect(actionsOf(cid).length).toBeGreaterThan(0), FAST);
    resetApi();
    setLatency(0);
    await sleep(60);
    expect(newAnalyses()).toHaveLength(0);
    expect(state.conversations.some((c) => c.id === cid)).toBe(false);
    expect(eventsOf(cid)).toEqual([]);
    expect(state.tasks.filter((t) => t.source === "server").map((t) => t.code)).toEqual(["ACQ-6"]);
    expect(state.notifications.some((n) => n.id.startsWith("n-alert"))).toBe(false);
  });

  it("R-L6: il server non si toglie mentre un'analisi lo guarda", async () => {
    setStreamLatency(20);
    await servers.simulateServerAlert("SRV-1", "memory");
    expect(await message(servers.deleteServer("SRV-1"))).toBe("invalid: busy");
    expect(state.servers.some((s) => s.code === "SRV-1")).toBe(true);
    await whenAnalysesIdle();
    expect(await message(servers.deleteServer("SRV-1"))).toBe("ok");
  });

  it("`failNext`, server invisibile e input sbagliati non aprono episodi", async () => {
    const before = state.serverEpisodes.length;
    failNext("servers.simulateServerAlert");
    expect(await message(servers.simulateServerAlert("SRV-1", "memory"))).toMatch(
      /Simulated failure/,
    );
    as("p-sara");
    expect(await message(servers.simulateServerAlert("SRV-3", "memory"))).toBe("not_found");
    expect(await message(servers.simulateServerRecovery("SRV-3"))).toBe("not_found");
    expect(await message(servers.simulateSshUnreachable("SRV-3", true))).toBe("not_found");
    as("p-roberta");
    expect(await message(servers.simulateServerAlert("SRV-1", "nope" as "cpu"))).toBe(
      "invalid: reason",
    );
    expect(
      await message(servers.simulateServerAlert("SRV-1", "cpu", { severity: "bad" as "down" })),
    ).toBe("invalid: severity");
    expect(await message(servers.simulateServerRecovery("SRV-1"))).toBe("invalid: state");
    expect(state.serverEpisodes.length).toBe(before);
  });
});

describe("R-L10: il full admin riceve gli avvisi dei server coi default", () => {
  it("Roberta (non membro di STW) riceve `server.trouble` di STW e lo può spegnere", async () => {
    const trouble = SERVER_ALERT_NOTIFICATIONS.find((n) => n.kind === "server.trouble")!;
    expect(trouble.projectId).toBe("prj-stw");
    expect(whyReceives("p-roberta", trouble)).toBe("subscribed");
    const stw = (await alerts.subscriptionRows()).find((p) => p.projectId === "prj-stw")!;
    expect(stw.rows.find((r) => r.type === "server.trouble")).toMatchObject({ state: "on" });

    await alerts.setSubscription("prj-stw", "server.trouble", { app: false });
    // Spegnere vale per il futuro: il rientro di SRV-2 non le arriva più.
    await servers.simulateServerRecovery("SRV-2");
    expect(whyReceives("p-roberta", published("server.recovered", "SRV-2")[0]!)).toBeNull();
    const after = (await alerts.subscriptionRows()).find((p) => p.projectId === "prj-stw")!;
    expect(after.rows.find((r) => r.type === "server.trouble")).toMatchObject({ state: "off" });
  });

  it("l'opzione è solo dei tipi server: gli altri restano spenti per il full admin non membro", () => {
    expect(alertTypeOf("server.trouble")!.defaultForFullAdmins).toBe(true);
    expect(alertTypeOf("server.diagnosis_ready")!.defaultForFullAdmins).toBe(true);
    expect(alertTypeOf("monitor.alert")!.defaultForFullAdmins).toBeUndefined();
    const monitorAlert = state.notifications.find(
      (n) => n.kind === "monitor.alert" && n.projectId === ACQ,
    )!;
    expect(whyReceives("p-roberta", monitorAlert)).toBeNull();
  });
});

describe("R-L9: Claude lavora in ogni progetto, anche in quelli creati dall'app", () => {
  it("R-K5 anche fuori dal catalogo: un destinatario fisso Claude non riceve", () => {
    const fixed: AppNotification = {
      ...state.notifications.find((n) => n.kind === "monitor.alert")!,
      id: "n-fixed-claude",
      kind: "security.alert",
      recipientIds: ["p-claude", "p-marco"],
    };
    expect(whyReceives("p-marco", fixed)).toBe("fixed");
    expect(whyReceives("p-claude", fixed)).toBeNull();
  });

  it("in un progetto nuovo l'analisi parte e apre la task", async () => {
    const p = await createProject({ code: "NEWP", name: "New production", template: "software" });
    expect(state.projectsById.get(p.id)!.memberIds).not.toContain("p-claude");
    const env = await releases.createEnvironment(p.id, {
      name: "Production",
      kind: "production",
      url: null,
      servers: [],
    });
    const { server } = await servers.createServer({ name: "newp-prod-01", environmentId: env.id });
    await servers.linkSshAccess(server.code);
    await servers.verifySshAccess(server.code);
    await servers.simulateServerAlert(server.code, "cpu");
    await whenAnalysesIdle();
    const a = onlyAnalysis(server.code);
    expect(a).toMatchObject({ projectId: p.id, outcome: "diagnosed" });
    expect(taskOf(a)).toMatchObject({ projectId: p.id, createdById: "p-claude", source: "server" });
    expect(published("server.trouble", server.code)[0]!.body).toMatch(/Claude is looking into it/);
    // La membership mostrata non cambia: Claude è membro implicito, non scritto.
    expect(state.projectsById.get(p.id)!.memberIds).not.toContain("p-claude");
  });
});

describe("analisi ai bordi (fix round 1)", () => {
  it("la task che non si apre: l'analisi finisce `failed`, mai `running`, e il server si toglie", async () => {
    // Nessuno stato «da fare» in ACQ: `createTaskAs` rifiuta.
    state.statuses = state.statuses.filter((s) => !(s.projectId === ACQ && s.family === "todo"));
    await servers.simulateServerAlert("SRV-1", "memory");
    await whenAnalysesIdle();
    const a = onlyAnalysis("SRV-1");
    expect(a.outcome).toBe("failed");
    expect(a.taskId).toBeNull();
    expect(sessionOf(a)).toMatchObject({ state: "finished", outcome: "failed" });
    expect(sessionOf(a).failureSummary).toMatch(/invalid: status/);
    // Chi aveva letto «Claude is looking into it» lo sa: un secondo avviso
    // dello stesso tipo, agli stessi progetti, e nessuna «diagnosi pronta».
    const [first, failed] = published("server.trouble", "SRV-1");
    expect(first!.body).toMatch(/Claude is looking into it/);
    expect(failed).toMatchObject({ projectId: ACQ, title: "Claude couldn't finish the analysis" });
    expect(failed!.body).toMatch(/couldn't open the task \(invalid: status\)/);
    expect(published("server.diagnosis_ready", "SRV-1")).toHaveLength(0);
    expect((await inbox("p-marco")).map((n) => n.id)).toContain(failed!.id);
    expect(whyReceives("p-claude", failed!)).toBeNull();
    as("p-roberta");
    expect(await message(servers.deleteServer("SRV-1"))).toBe("ok");
  });

  it("un allarme su un episodio aperto ad analisi finita lascia una traccia nella task", async () => {
    await servers.simulateServerAlert("SRV-1", "memory");
    await whenAnalysesIdle();
    const task = taskOf(onlyAnalysis("SRV-1"));
    await servers.simulateServerAlert("SRV-1", "disk");
    expect(task.description).toMatch(/\*\*New alert\*\* — disk at 96% \(alert at 90%\)\./);
    await servers.simulateServerAlert("SRV-1", "agent_silent", { severity: "down" });
    expect(task.description).toMatch(/the agent stopped reporting; the server stopped responding/);
    // Nessuna analisi e nessun avviso nuovi.
    expect(newAnalyses("SRV-1")).toHaveLength(1);
    expect(published("server.trouble", "SRV-1")).toHaveLength(1);
    expect(published("server.down", "SRV-1")).toHaveLength(0);
  });

  it("una revoca durante l'analisi la ferma: nessuna lettura dopo, task «Stopped»", async () => {
    setStreamLatency(20);
    await servers.simulateServerAlert("SRV-1", "memory");
    await vi.waitFor(() => expect(newAnalyses("SRV-1")).toHaveLength(1), FAST);
    const a = onlyAnalysis("SRV-1");
    await vi.waitFor(() => expect(actionsOf(a.conversationId).length).toBeGreaterThan(0), FAST);
    await servers.revokeSshAccess("SRV-1");
    const readsAtRevoke = actionsOf(a.conversationId).length;
    await whenAnalysesIdle();
    expect(a.outcome).toBe("stopped");
    expect(sessionOf(a)).toMatchObject({ state: "finished", outcome: "failed" });
    expect(actionsOf(a.conversationId).length).toBe(readsAtRevoke);
    expect(actionsOf(a.conversationId).every((x) => x.state !== "running")).toBe(true);
    expect(taskOf(a).description).toMatch(/\*\*Stopped\*\* — the read-only SSH access stopped/);
  });

  it("una «lettura che scrive» durante l'analisi la ferma alla lettura successiva", async () => {
    setStreamLatency(20);
    await servers.simulateServerAlert("SRV-1", "memory");
    await vi.waitFor(() => expect(newAnalyses("SRV-1")).toHaveLength(1), FAST);
    const a = onlyAnalysis("SRV-1");
    await vi.waitFor(() => expect(actionsOf(a.conversationId).length).toBeGreaterThan(0), FAST);
    await servers.simulateSshVerifyOutcome("SRV-1", "read_writes");
    await servers.verifySshAccess("SRV-1");
    await whenAnalysesIdle();
    expect(a.outcome).toBe("stopped");
    expect(actionsOf(a.conversationId).length).toBeLessThan(5);
  });

  it("rientro prima della prima lettura: nessuna diagnosi inventata, nessun uso registrato", async () => {
    const lastUse = structuredClone(state.serverAccess.get("SRV-1")!.lastUse);
    setStreamLatency(20);
    await servers.simulateServerAlert("SRV-1", "memory");
    await servers.simulateServerRecovery("SRV-1");
    await whenAnalysesIdle();
    const a = onlyAnalysis("SRV-1");
    expect(actionsOf(a.conversationId)).toHaveLength(0);
    expect(a.outcome).toBe("stopped");
    expect(sessionOf(a)).toMatchObject({ state: "finished", outcome: "ok" });
    const task = taskOf(a);
    expect(task.description).toMatch(/Back to normal before Claude looked/);
    expect(task.description).not.toMatch(/\*\*Diagnosis\*\*/);
    expect(state.serverAccess.get("SRV-1")!.lastUse).toEqual(lastUse);
  });
});
