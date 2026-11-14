import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { releases, resetApi, servers, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { state, visibleProjectIds } from "../store";
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

  it("senza l'accesso di lettura usabile non parte: `invalid: access`, e il dettaglio non la offre", async () => {
    const code = await stagingServer({ access: false });
    as("p-marco");
    expect((await servers.getServer(code)).canStartAnalysis).toBe(false);
    const before = state.serverAnalyses.length;
    expect(await message(servers.startServerAnalysis(code))).toBe("invalid: access");
    expect(state.serverAnalyses).toHaveLength(before);
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
