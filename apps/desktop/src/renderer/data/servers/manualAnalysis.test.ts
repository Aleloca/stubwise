import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { whyReceives } from "../alerts/visibility";
import { createProject, releases, resetApi, servers, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { eventsOf, state, visibleProjectIds } from "../store";
import { can, viewerFor } from "../viewer";
import { whenAnalysesIdle } from "./analysis";

// Area 8, F4b (R0-A2): l'analisi a mano di un server, «Ask Claude to look
// into it». La chiede chi ha `servers.operate` in UN progetto il cui
// ambiente usa il server, staging compreso (un server di solo staging non si
// analizza da solo); stesse regole dell'automatica (sola lettura, tetti,
// attribuzione). Nessun episodio (`episodeId: null`, come sul server), e
// chi l'ha chiesta resta scritto (`startedBy`).

const ACQ = "prj-acq";
const as = (personId: string) => setSessionPersonId(personId);
const message = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error) => e.message,
  );

const outsider = () =>
  PEOPLE.find(
    (p) =>
      p.id !== CLAUDE_ID &&
      !visibleProjectIds(p.id).has(ACQ) &&
      !can(viewerFor(p.id), "monitor.view"),
  )!.id;

/** Un server sul solo staging di ACQ, con l'accesso di lettura verificato. */
async function stagingServer(opts: { access?: boolean } = {}): Promise<string> {
  as("p-roberta");
  const env = await releases.createEnvironment(ACQ, {
    name: "Staging",
    kind: "staging",
    url: null,
    servers: [],
  });
  const { server } = await servers.createServer({ name: "acq-stage-01", environmentId: env.id });
  if (opts.access === false) return server.code;
  await servers.linkSshAccess(server.code);
  expect((await servers.verifySshAccess(server.code)).usable).toBe(true);
  return server.code;
}

beforeEach(() => {
  resetApi();
  setLatency(0);
});

afterEach(async () => {
  await whenAnalysesIdle();
  resetApi();
});

describe("avvio a mano dell'analisi (R0-A2)", () => {
  it("Marco (servers.operate in ACQ) la avvia su un server di solo staging: nessun episodio, chi l'ha chiesta", async () => {
    const code = await stagingServer();
    as("p-marco");
    const view = await servers.startServerAnalysis(code);
    expect(view).toMatchObject({
      serverCode: code,
      episodeId: null,
      outcome: "running",
      startedBy: { id: "p-marco", name: "Marco Bellini" },
    });
    const a = state.serverAnalyses.find((x) => x.id === view.id)!;
    expect(a).toMatchObject({ episodeId: null, startedBy: "p-marco" });
    // Nessun episodio nato per l'analisi a mano.
    expect(state.serverEpisodes.filter((e) => e.serverCode === code)).toEqual([]);

    await whenAnalysesIdle();
    const done = state.serverAnalyses.find((x) => x.id === view.id)!;
    expect(done.outcome).toBe("diagnosed");
    // Un solo progetto usa il server: la task nasce lì, con lo sguardo a mano nel testo.
    expect(done.attribution).toEqual({ kind: "attributed", projectId: ACQ, projectCode: "ACQ" });
    const task = state.tasksById.get(done.taskId!)!;
    expect(task.projectId).toBe(ACQ);
    expect(task.serverRef).toEqual({ serverCode: code, episodeId: null });
    expect(task.description).toMatch(/asked by Marco Bellini/);
  });

  it("il dettaglio dice chi può avviarla e mostra l'ultima a mano", async () => {
    const code = await stagingServer();
    as("p-laura");
    expect((await servers.getServer(code)).canStartAnalysis).toBe(false);
    as("p-marco");
    const before = await servers.getServer(code);
    expect(before.canStartAnalysis).toBe(true);
    expect(before.manualAnalysis).toBeNull();
    await servers.startServerAnalysis(code);
    const during = await servers.getServer(code);
    expect(during.manualAnalysis).toMatchObject({
      outcome: "running",
      startedBy: { id: "p-marco" },
    });
    // Mentre gira non se ne avvia un'altra.
    expect(during.canStartAnalysis).toBe(false);
  });

  it("una già in corso sul server: `invalid: analysis_running` (anche se l'ha avviata l'allarme)", async () => {
    as("p-roberta");
    await servers.simulateServerAlert("SRV-1", "memory");
    expect(
      state.serverAnalyses.some((a) => a.serverCode === "SRV-1" && a.outcome === "running"),
    ).toBe(true);
    as("p-marco");
    const before = state.serverAnalyses.length;
    expect(await message(servers.startServerAnalysis("SRV-1"))).toBe("invalid: analysis_running");
    expect(state.serverAnalyses).toHaveLength(before);
  });

  it("senza servers.operate in nessun progetto del server: forbidden; invisibile: not_found", async () => {
    const code = await stagingServer();
    as("p-laura");
    const before = state.serverAnalyses.length;
    expect(await message(servers.startServerAnalysis(code))).toBe("forbidden");
    // Chi non legge ACQ non vede il server (e non ha `monitor.view`).
    as(outsider());
    expect(await message(servers.startServerAnalysis(code))).toBe("not_found");
    expect(await message(servers.startServerAnalysis("SRV-404"))).toBe("not_found");
    expect(state.serverAnalyses).toHaveLength(before);
  });

  it("senza l'accesso di lettura parte lo stesso (come sul server): niente letture SSH, lo dice, e scrive la diagnosi", async () => {
    const code = await stagingServer({ access: false });
    as("p-marco");
    expect((await servers.getServer(code)).canStartAnalysis).toBe(true);
    const view = await servers.startServerAnalysis(code);
    await whenAnalysesIdle();
    const a = state.serverAnalyses.find((x) => x.id === view.id)!;
    // Lo stato del server lo legge sempre (dal database): diagnosi, non «rientrato».
    expect(a.outcome).toBe("diagnosed");
    const said = eventsOf(a.conversationId)
      .flatMap((e) => (e.type === "assistant" ? [e.text] : []))
      .join("\n");
    expect(said).toMatch(/can't read over SSH/);
    const reads = eventsOf(a.conversationId).filter(
      (e) => e.type === "action" && e.serverCommand?.via === "ssh",
    );
    expect(reads).toEqual([]);
    expect(state.serverAccess.get(code)?.lastUse ?? null).toBeNull();
  });
});

describe("la vista dell'analisi: `sessionId` e `canViewDiagnosis` (regola del server)", () => {
  it("prima dell'attribuzione solo chi gestisce il monitor; dopo anche chi legge il progetto attribuito", async () => {
    const code = await stagingServer();
    as("p-marco");
    const view = await servers.startServerAnalysis(code);
    // Marco non gestisce il monitor: mentre gira niente sessione né diagnosi.
    expect(view).toMatchObject({ sessionId: null, canViewDiagnosis: false });
    as("p-roberta");
    const mine = (await servers.getServer(code)).manualAnalysis!;
    expect(mine.sessionId).toBe(state.serverAnalyses.find((x) => x.id === view.id)!.conversationId);
    expect(mine.canViewDiagnosis).toBe(true);

    await whenAnalysesIdle();
    as("p-marco");
    const after = (await servers.getServer(code)).manualAnalysis!;
    expect(after.canViewDiagnosis).toBe(true);
    expect(after.sessionId).not.toBeNull();
  });
});

describe("l'esito «non determinata» a chi l'ha chiesta (decisione del maintainer, 15 nov 2026)", () => {
  /** Le card nate nel test per un server. */
  const cards = (code: string) =>
    state.notifications.filter(
      (n) =>
        n.id.startsWith("n-alert") && n.kind === "server.diagnosis_ready" && n.objectCode === code,
    );

  it("su un server di solo staging: nessuna produzione da avvisare, ma Marco riceve l'esito, e resta sulla pagina", async () => {
    const code = await stagingServer();
    // Un secondo progetto sullo stesso server: senza container la causa non si dice.
    const other = await createProject({ code: "STGX", name: "Other", template: "software" });
    await releases.createEnvironment(other.id, {
      name: "Staging",
      kind: "staging",
      url: null,
      servers: [{ repositoryId: null, serverCode: code }],
    });
    as("p-marco");
    const view = await servers.startServerAnalysis(code);
    await whenAnalysesIdle();
    const a = state.serverAnalyses.find((x) => x.id === view.id)!;
    expect(a.attribution?.kind).toBe("undetermined");
    const [card, ...more] = cards(code);
    expect(more).toEqual([]);
    expect(card).toMatchObject({
      projectId: ACQ,
      title: "Cause not determined",
      link: `#/p/ACQ/servers/${code}`,
    });
    expect(whyReceives("p-marco", card!)).toBe("analysis_requester");
    // Solo per lui (`mandatoryOnly`): gli iscritti del progetto non la ricevono.
    expect(whyReceives("p-roberta", card!)).toBeNull();
    // E resta visibile sulla pagina del server, col perché.
    const last = (await servers.getServer(code)).manualAnalysis!;
    expect(last.attribution).toMatchObject({ kind: "undetermined" });
  });

  it("su un server di produzione la card del suo progetto lo porta fra gli obbligatori, senza doppioni", async () => {
    as("p-roberta");
    const other = await createProject({ code: "SRVX", name: "Second", template: "software" });
    await releases.createEnvironment(other.id, {
      name: "Production",
      kind: "production",
      url: null,
      servers: [{ repositoryId: null, serverCode: "SRV-1" }],
    });
    // Senza i container di ACQ la causa (`postgres`) non è di nessuno.
    state.environments.find((e) => e.id === "env-acq-prod")!.servers[0]!.containers = [];
    as("p-marco");
    await servers.startServerAnalysis("SRV-1");
    await whenAnalysesIdle();
    const acq = cards("SRV-1").filter((n) => n.projectId === ACQ);
    expect(acq).toHaveLength(1);
    expect(acq[0]!.mandatory).toEqual([{ personId: "p-marco", reason: "analysis_requester" }]);
    expect(whyReceives("p-marco", acq[0]!)).toBe("analysis_requester");
    expect(cards("SRV-1").filter((n) => n.projectId === other.id)).toHaveLength(1);
  });

  it("attribuita a un progetto che vede: obbligatoria sulla diagnosi di quel progetto, una card sola", async () => {
    as("p-marco");
    await servers.startServerAnalysis("SRV-1");
    await whenAnalysesIdle();
    const [card, ...more] = cards("SRV-1");
    expect(more).toEqual([]);
    expect(card).toMatchObject({ projectId: ACQ, title: "Diagnosis ready" });
    expect(card!.mandatory).toEqual([{ personId: "p-marco", reason: "analysis_requester" }]);
    expect(whyReceives("p-marco", card!)).toBe("analysis_requester");
  });

  it("fallita (la task non si apre): l'esito a lui solo, nel suo progetto", async () => {
    // Nessuno stato «da fare» in ACQ: `createTaskAs` rifiuta.
    state.statuses = state.statuses.filter((x) => !(x.projectId === ACQ && x.family === "todo"));
    as("p-marco");
    const view = await servers.startServerAnalysis("SRV-1");
    await whenAnalysesIdle();
    expect(state.serverAnalyses.find((x) => x.id === view.id)!.outcome).toBe("failed");
    const mine = state.notifications.filter(
      (n) => n.id.startsWith("n-alert") && n.objectCode === "SRV-1" && n.mandatoryOnly,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      kind: "server.diagnosis_ready",
      projectId: ACQ,
      title: "Claude couldn't finish the analysis",
    });
    expect(whyReceives("p-marco", mine[0]!)).toBe("analysis_requester");
    expect(whyReceives("p-roberta", mine[0]!)).toBeNull();
  });
});
