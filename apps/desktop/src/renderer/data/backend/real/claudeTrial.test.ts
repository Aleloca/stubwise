import type { AutomationTrigger, SimulationExample } from "@stubwise/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTrialRunner,
  forgetTrials,
  setTrialRunnerForTests,
  withSettledTrialEvents,
  withTrialEvents,
  type TrialDeps,
  type TrialRun,
  type TrialSim,
} from "./claudeTrial";

type Done = Extract<TrialRun, { status: "done" }>;

// La prova di Claude nella build app (area 10, F2, S1; prototipo
// `data/claude/trial.ts`): dopo un `createAutomation` eseguito, il renderer
// prova la bozza sugli esempi veri del server (`GET …/examples?version=draft`)
// con la simulazione del renderer. Uno che passa il filtro dell'inizio e, se
// l'inizio ha un filtro, uno che non passa; la prova si ferma prima di un
// passo di Claude. Ne nasce l'evento `trial` del prototipo (la riga della
// prova, e il costruttore che si apre da sé sulla prima che passa).

const A_ID = "77777777-7777-4777-8777-777777777771";
const urgentOnly: AutomationTrigger = {
  kind: "stubwise",
  event: "request_created",
  filter: { all: [{ left: { ref: "richiesta.urgenza" }, op: "is", right: { value: "urgent" } }] },
} as never;
const noFilter: AutomationTrigger = { kind: "stubwise", event: "request_created" } as never;

const example = (code: string, urgency: string): SimulationExample => ({
  label: `${code} Invoices`,
  code,
  at: "2026-11-18T09:00:00.000Z",
  event: { richiesta: { urgenza: urgency, dal_supporto: true } },
});

const sim = (over: Partial<TrialSim> = {}): TrialSim => ({
  status: "done",
  filteredOut: false,
  current: null,
  costToConfirm: null,
  waiting: null,
  preview: { tasks: [], milestones: [], requests: [], emails: [], notifications: [{}] },
  ...over,
});

function deps(
  over: Partial<TrialDeps> & { trigger?: AutomationTrigger; examples?: SimulationExample[] } = {},
) {
  const started: Record<string, unknown>[] = [];
  const stepped: string[] = [];
  const d: TrialDeps = {
    automationIdOf: async (code) => (code === "AUD-A3" ? A_ID : null),
    draftTrigger: async () => over.trigger ?? urgentOnly,
    listExamples: async () =>
      over.examples ?? [example("AUD-R1", "low"), example("AUD-R2", "urgent")],
    start: async (_id, event) => {
      started.push(event);
      return `sim-${started.length}`;
    },
    step: async (simId) => {
      stepped.push(simId);
      return sim();
    },
    get: async () => sim(),
    ...over,
  };
  return { d, started, stepped };
}

describe("la prova di Claude nella build app", () => {
  it("uno che passa e, con un filtro, uno che non passa: gli esiti nell'ordine, e si apre il primo che passa", async () => {
    const { d, started } = deps({
      examples: [
        example("AUD-R1", "low"),
        example("AUD-R2", "urgent"),
        example("AUD-R3", "urgent"),
      ],
      get: async (simId) =>
        simId === "sim-2" ? sim({ filteredOut: true, preview: sim().preview }) : sim(),
    });
    const out = (await createTrialRunner(d).run("AUD-A3")) as Done;
    // Il più recente che passa (il primo dell'elenco del server), poi il più recente che non passa.
    expect(started).toEqual([example("AUD-R2", "urgent").event, example("AUD-R1", "low").event]);
    expect(out).toMatchObject({
      status: "done",
      automationId: A_ID,
      code: "AUD-A3",
      openSimId: "sim-1",
    });
    expect(out.results).toEqual([
      expect.objectContaining({
        simId: "sim-1",
        status: "done",
        notifications: 1,
        label: {
          key: "claude.trial.example",
          params: { code: "AUD-R2", title: "AUD-R2 Invoices" },
        },
        written: false,
      }),
      expect.objectContaining({ simId: "sim-2", status: "filtered_out" }),
    ]);
  });

  // Lotto 6, voce 5 (72, f7964e643): senza un esempio vero, quelli scritti
  // dalla regola deterministica del server (`written`), etichettati «Example
  // written by Claude». Uno che non sta dalla parte giusta del filtro si
  // scarta (I1 del prototipo): la prova non dice ciò che il dato non dimostra.
  it("senza esempi veri: quelli scritti dal server, verificati col filtro", async () => {
    const passing = { richiesta: { urgenza: "urgent" } };
    const failing = { richiesta: { urgenza: "low" } };
    const { d, started } = deps({
      examples: [],
      writtenExamples: async () => ({ passes: passing, fails: failing }),
    });
    const out = (await createTrialRunner(d).run("AUD-A3")) as Done;
    expect(started).toEqual([passing, failing]);
    expect(out.results).toEqual([
      expect.objectContaining({ label: { key: "claude.trial.exampleWritten" }, written: true }),
      expect.objectContaining({ label: { key: "claude.trial.exampleWritten" }, written: true }),
    ]);
    // Dalla parte sbagliata (un «passa» che il filtro ferma): scartato.
    const wrong = deps({
      examples: [],
      writtenExamples: async () => ({ passes: failing, fails: null }),
    });
    expect(((await createTrialRunner(wrong.d).run("AUD-A3")) as Done).results).toEqual([]);
    expect(wrong.started).toEqual([]);
    // Un esempio vero che passa vince su quello scritto.
    const real = deps({
      examples: [example("AUD-R2", "urgent")],
      writtenExamples: async () => ({ passes: passing, fails: failing }),
    });
    await createTrialRunner(real.d).run("AUD-A3");
    expect(real.started).toEqual([example("AUD-R2", "urgent").event, failing]);
  });

  it("senza filtro nell'inizio: solo l'esempio che passa", async () => {
    const { d, started } = deps({ trigger: noFilter });
    const out = (await createTrialRunner(d).run("AUD-A3")) as Done;
    expect(started).toHaveLength(1);
    expect(out.results).toHaveLength(1);
  });

  it("nessun esempio che passa: nessuna prova da aprire", async () => {
    const { d } = deps({ examples: [example("AUD-R1", "low")] });
    const out = (await createTrialRunner(d).run("AUD-A3")) as Done;
    expect(out.openSimId).toBeNull();
    expect(out.results!.map((r) => r.simId)).toEqual(["sim-1"]);
  });

  it("va avanti passo per passo e si ferma prima di un passo di Claude, senza eseguirlo", async () => {
    const stepped: string[] = [];
    let n = 0;
    const { d } = deps({
      trigger: noFilter,
      get: async () => sim({ status: "running", current: { kind: "notify" } }),
      step: async (simId) => {
        stepped.push(simId);
        n += 1;
        return n < 2
          ? sim({ status: "running", current: { kind: "createTask" } })
          : sim({ status: "running", current: { kind: "claude" } });
      },
    });
    const out = (await createTrialRunner(d).run("AUD-A3")) as Done;
    expect(stepped).toEqual(["sim-1", "sim-1"]);
    expect(out.results![0]).toMatchObject({ status: "running", stoppedAtClaude: true });
  });

  it("si ferma anche davanti a un costo da confermare, e a chi approva", async () => {
    const { d, stepped } = deps({
      trigger: noFilter,
      get: async () =>
        sim({
          status: "waiting_approval",
          waiting: { kind: "approval", who: { personId: "p-laura" } },
        }),
    });
    const out = (await createTrialRunner(d, { visible: (id) => id === "p-laura" }).run(
      "AUD-A3",
    )) as Done;
    expect(stepped).toEqual([]);
    expect(out.results![0]).toMatchObject({ status: "waiting_approval", approverId: "p-laura" });
  });

  it("chi approverebbe, se chi chiede non lo vede, non si nomina (R-G5)", async () => {
    const { d } = deps({
      trigger: noFilter,
      get: async () =>
        sim({
          status: "waiting_approval",
          waiting: { kind: "approval", who: { personId: "p-x" } },
        }),
    });
    const out = (await createTrialRunner(d, { visible: () => false }).run("AUD-A3")) as Done;
    expect(out.results![0]!.approverId).toBeNull();
  });

  it("un'automazione che non si trova, o una prova che non parte: `skipped`, senza esiti", async () => {
    const { d } = deps();
    expect(await createTrialRunner(d).run("AUD-A9")).toEqual({ status: "skipped" });
    const failing = deps({
      start: async () => {
        throw new Error("invalid: config");
      },
    });
    expect(await createTrialRunner(failing.d).run("AUD-A3")).toEqual({ status: "skipped" });
  });
});

describe("la riga della prova nella conversazione", () => {
  const executed = (groupId: string) =>
    ({
      id: `executed:${groupId}`,
      at: "2026-11-19T10:00:00.000Z",
      type: "executed",
      groupId,
    }) as never;
  const group = (id: string, fn: string, codes: string[]) =>
    ({ id, actions: [{ fn, args: {}, codes }] }) as never;
  const done: TrialRun = {
    status: "done",
    automationId: A_ID,
    code: "AUD-A3",
    wants: ["passes"],
    results: [],
    openSimId: null,
  };

  beforeEach(() => forgetTrials());
  afterEach(() => setTrialRunnerForTests(null));

  it("dopo un `createAutomation` eseguito: in attesa, poi fatta; una prova sola per gruppo", async () => {
    const codes: string[] = [];
    setTrialRunnerForTests(() => ({
      run: async (code) => {
        codes.push(code);
        return done;
      },
    }));
    let settled = 0;
    const groups = [group("g1", "createAutomation", ["AUD-A3"])];
    const first = withTrialEvents([executed("g1")], groups, true, () => (settled += 1));
    expect(first.map((e) => (e as { id: string }).id)).toEqual(["executed:g1", "trial:g1"]);
    expect(first[1]).toMatchObject({ type: "trial", status: "pending" });
    await vi.waitFor(() => expect(settled).toBe(1));
    const again = withTrialEvents([executed("g1")], groups, true);
    expect(again[1]).toMatchObject({
      type: "trial",
      status: "done",
      code: "AUD-A3",
      automationId: A_ID,
    });
    expect(codes).toEqual(["AUD-A3"]);
  });

  it("niente prova per chi non è l'autore, né per un gruppo che non ha creato un'automazione", () => {
    setTrialRunnerForTests(() => ({ run: async () => done }));
    expect(
      withTrialEvents([executed("g1")], [group("g1", "createAutomation", ["AUD-A3"])], false),
    ).toHaveLength(1);
    expect(
      withTrialEvents([executed("g2")], [group("g2", "createTask", ["AUD-12"])], true),
    ).toHaveLength(1);
  });

  it("il dettaglio aspetta la prova", async () => {
    setTrialRunnerForTests(() => ({ run: async () => done }));
    const out = await withSettledTrialEvents(
      [executed("g1")],
      [group("g1", "createAutomation", ["AUD-A3"])],
      true,
    );
    expect(out[1]).toMatchObject({ status: "done", code: "AUD-A3" });
  });
});
