import i18n from "i18next";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { readsAs } from "../../data/api-mutations";
import { classOfGroup } from "../../data/claude/classes";
import { daysFromToday } from "../../data/dates";
import { isAppRoute } from "../../data/routes";
import { PEOPLE } from "../../data/seed/people";
import { setSessionPersonId } from "../../data/session";
import { advanceNow, familyOf, now, openDecisions, state } from "../../data/store";
import type { CapabilityId, ConversationEvent, ScriptStep, Task } from "../../data/types";
import { can, viewerFor } from "../../data/viewer";
import { usd } from "../../i18n/money";
import { stallOf } from "../stalled";
import { toSteps } from "./answers";
import { recognize, respond, type IntentContext } from "./intents";
import { isHowToQuestion } from "./parse";

// Le risposte di Claude sui dati (area 10b, Task 6): la risposta onesta (S0),
// i progetti fermi (S2) e la spesa del mese (S3). Ogni numero si confronta
// col calcolo indipendente sul seme, letto come la persona; l'invisibile non
// esiste (R-G5, test insensibili alle maiuscole); una deduzione è un `aside`,
// mai la prima riga.

const en = i18n.getFixedT("en");
const it_ = i18n.getFixedT("it");
const ROBERTA = "p-roberta";
const GIULIA = "p-giulia";
const LAURA = "p-laura";
const SARA = "p-sara";

function as(
  personId: string,
  t = en,
  contextProjectId: string | null = null,
  extra: Partial<IntentContext> = {},
): IntentContext {
  setSessionPersonId(personId);
  return {
    personId,
    contextProjectId,
    read: readsAs(personId),
    t,
    seed: "conv-10b-data",
    classify: async (actions) => classOfGroup(personId, actions),
    asks: true,
    ...extra,
  };
}

const said = (steps: ScriptStep[]) =>
  steps.flatMap((s) => (s.step === "say" ? [s.text] : [])).join("\n");
type Draft<T extends ConversationEvent["type"]> = Omit<
  Extract<ConversationEvent, { type: T }>,
  "id" | "at"
>;
function events<T extends ConversationEvent["type"]>(steps: ScriptStep[], type: T): Draft<T>[] {
  return steps.flatMap((s) =>
    s.step === "event" && s.event.type === type ? [s.event as unknown as Draft<T>] : [],
  );
}
const asides = (steps: ScriptStep[], kind: "hypothesis" | "details") =>
  events(steps, "aside").filter((a) => a.kind === kind);
/** Tutto ciò che la risposta dice, in minuscolo: testo e righe a parte. */
const everything = (steps: ScriptStep[]) =>
  [said(steps), ...events(steps, "aside").map((a) => a.text)].join("\n").toLowerCase();
const bullets = (text: string) => text.split("\n").filter((l) => l.startsWith("- "));
const projectId = (code: string) => state.projects.find((p) => p.code === code)!.id;
const word = (w: string) => new RegExp(`(^|[^a-z0-9])${w.toLowerCase()}([^a-z0-9]|$)`);

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
});

/** Il calcolo indipendente: `stallOf` sulle task dei progetti che la persona vede. */
async function expectedStalled(personId: string, onlyCode?: string) {
  setSessionPersonId(personId);
  const projects = (await api.listProjects()).filter((p) => !onlyCode || p.code === onlyCode);
  const tasks = await api.listTasks();
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const rows: { code: string; stalled: number; days: number }[] = [];
  for (const p of projects) {
    const days = tasks
      .filter((t) => t.projectId === p.id)
      .flatMap((t: Task) => {
        const stall = stallOf(t, {
          family: familyOf(t),
          openDecisions: openDecisions(),
          tasksById,
          familyOf,
          thresholds: p.stallThresholds,
        });
        return stall ? [stall.days] : [];
      });
    if (days.length > 0) rows.push({ code: p.code, stalled: days.length, days: Math.max(...days) });
  }
  return rows.sort((a, b) => b.days - a.days || a.code.localeCompare(b.code));
}

/** Archivia ogni progetto aperto tranne `keep`: per chi guarda gli altri non esistono più. */
function keepOnly(codes: string[]) {
  for (const p of state.projects)
    if (!codes.includes(p.code)) p.archived = { at: now(), byId: ROBERTA };
}

/** Rende ferme a mano `count` task aperte di un progetto, da `days` giorni. */
function stallManually(code: string, count: number, days: number) {
  const open = state.tasks.filter(
    (t) => t.projectId === projectId(code) && familyOf(t) !== "closed",
  );
  expect(open.length).toBeGreaterThanOrEqual(count);
  for (const task of open.slice(0, count)) {
    task.manualStall = {
      reason: "waiting for the supplier",
      note: "",
      since: daysFromToday(-days),
      byId: ROBERTA,
    };
  }
  return open.slice(0, count);
}

describe("il riconoscimento (P10)", () => {
  for (const [text, intent] of [
    ["which projects are stuck?", "stalled"],
    ["Which projects are stalled and why?", "stalled"],
    ["Quali progetti sono fermi e perché?", "stalled"],
    ["Which tasks are stalled in ACQ, and why?", "stalled"],
    ["Quali task sono ferme in ACQ, e perché?", "stalled"],
    ["quanto abbiamo speso in AI questo mese?", "spend"],
    ["How much have we spent on AI this month?", "spend"],
    ["Quanto spende Roberta?", "spend"],
    ["How much does Roberta spend?", "spend"],
  ] as const) {
    it(`«${text}» è ${intent}, non explain né general`, () => {
      expect(recognize(text, new Set(["ACQ", "AUD"]))).toBe(intent);
    });
  }
  for (const text of ["Ferma la task AUD-3", "AUD-3 è ferma?", "Who can see usage?"]) {
    it(`«${text}» non è una domanda sui fermi né sulla spesa`, () => {
      expect(["stalled", "spend"]).not.toContain(recognize(text, new Set(["AUD"])));
    });
  }
  // Le domande «come si fa» vanno a `howto` (revisione T6 I1, ruling T6 I1:
  // un solo controllo, `isHowToQuestion`, per tutti i riconoscitori nuovi).
  for (const text of [
    "How do I mark a task as stalled?",
    "Come si segna una task come ferma?",
    "How do I set the AI usage budget?",
    "Come si imposta il budget dei consumi?",
    "How does AI usage work?",
    "Come funzionano i consumi dell'AI?",
  ]) {
    it(`«${text}» è howto, non stalled né spend`, () => {
      expect(isHowToQuestion(text)).toBe(true);
      expect(recognize(text, new Set(["AUD"]))).toBe("howto");
    });
  }
  // Lo stesso controllo vale per le automazioni (T5 I3), e non scambia «How much…».
  it("«Come si crea un'automazione?» e «How do I create an automation?» non sono automazioni", () => {
    for (const text of ["Come si crea un'automazione?", "How do I create an automation?"]) {
      expect(isHowToQuestion(text)).toBe(true);
      expect(recognize(text)).not.toBe("automation");
    }
    expect(isHowToQuestion("How much have we spent on AI this month?")).toBe(false);
    expect(isHowToQuestion("Quanto abbiamo speso in AI questo mese?")).toBe(false);
  });
});

describe("S0, la risposta onesta", () => {
  const NINE: CapabilityId[] = [
    "automation",
    "stalled",
    "spend",
    "archive",
    "addMember",
    "supportReply",
    "releaseNotes",
    "mailBody",
    "taskDescription",
  ];
  for (const [text, t, first] of [
    ["What's the weather like in Milan?", en, "In the prototype I can do these things:"],
    ["write me a poem", en, "In the prototype I can do these things:"],
    ["Qual è la capitale del Portogallo?", it_, "Nel prototipo so fare queste cose:"],
    ["scrivimi una poesia", it_, "Nel prototipo so fare queste cose:"],
  ] as const) {
    it(`«${text}»: la prima riga e le nove voci`, async () => {
      const steps = await respond(text, as(GIULIA, t));
      expect(said(steps)).toBe(first);
      expect(events(steps, "capabilities")).toEqual([{ type: "capabilities", items: NINE }]);
      // Subito dopo il testo.
      const kinds = steps.flatMap((s) =>
        s.step === "say" ? ["say"] : s.step === "event" ? [s.event.type] : [],
      );
      expect(kinds).toEqual(["say", "capabilities"]);
    });
  }

  it("nessuna frase d'esempio né etichetta nomina un oggetto del seme", () => {
    const names = [
      ...state.projects.flatMap((p) => [p.code, p.name]),
      ...PEOPLE.flatMap((p) => [p.name, p.name.split(" ")[0]!]),
    ].filter((n) => n.length >= 2 && n !== "Claude");
    for (const t of [en, it_]) {
      for (const id of NINE) {
        for (const part of ["label", "prompt"]) {
          const line = t(`claude.answers.capabilities.${part}.${id}`);
          expect(line, `${part}.${id}`).not.toMatch(/^claude\./);
          for (const n of names) expect(line.toLowerCase(), `${id}: ${n}`).not.toMatch(word(n));
        }
      }
    }
  });

  it("nessuna riga dice che Claude chiede sempre conferma", async () => {
    for (const t of [en, it_]) {
      const steps = await respond("write me a poem", as(GIULIA, t));
      const lines = [
        said(steps),
        ...NINE.flatMap((id) => [
          t(`claude.answers.capabilities.label.${id}`),
          t(`claude.answers.capabilities.prompt.${id}`),
        ]),
      ].join("\n");
      expect(lines).not.toMatch(/always ask|confirm before|sempre conferma|chiedendoti/i);
    }
  });

  it("nella Chat (senza `classify`) lo stesso evento", async () => {
    const steps = await respond("write me a poem", as(GIULIA, en, null, { classify: undefined }));
    expect(events(steps, "capabilities")).toEqual([{ type: "capabilities", items: NINE }]);
    // Anche `toSteps` da solo, senza classe: l'evento non dipende dal riquadro.
    const direct = toSteps(
      { actions: [], text: "x", capabilities: ["stalled"] },
      { ...as(GIULIA), classify: undefined },
      "x",
    );
    expect(events(direct, "capabilities")).toEqual([{ type: "capabilities", items: ["stalled"] }]);
  });
});

describe("S2, i progetti fermi", () => {
  for (const personId of [GIULIA, ROBERTA]) {
    it(`${personId}: i numeri uguali al calcolo indipendente`, async () => {
      const expected = await expectedStalled(personId);
      expect(expected.length).toBeGreaterThan(5);
      const steps = await respond("which projects are stuck?", as(personId));
      const text = said(steps);
      expect(text.split("\n")[0]).toBe(`${expected.length} projects have stalled tasks`);
      const lines = bullets(text);
      expect(lines).toHaveLength(5);
      expected.slice(0, 5).forEach((row, i) => {
        expect(lines[i]).toMatch(
          new RegExp(
            `^- \\*\\*${row.code}\\*\\* — ${row.stalled} stalled tasks?, (the oldest )?for ${row.days} days? \\(`,
          ),
        );
      });
      expect(text).toContain(
        `and ${expected.length - 5} more · [open the list](#/projects?view=stalled)`,
      );
      expect(everything(steps)).not.toMatch(/only (the ones|those)|you can see|solo quell/);
      // Italiano: la stessa forma.
      const it = said(await respond("Quali progetti sono fermi e perché?", as(personId, it_)));
      expect(it.split("\n")[0]).toBe(`${expected.length} progetti hanno task ferme`);
      expect(it).toContain(
        `e altri ${expected.length - 5} · [apri l'elenco](#/projects?view=stalled)`,
      );
    });
  }

  it("Giulia non legge codici, nomi né conteggi dei progetti che vede solo Roberta", async () => {
    const giulia = await expectedStalled(GIULIA);
    const roberta = await expectedStalled(ROBERTA);
    const seen = new Set(giulia.map((r) => r.code));
    const only = state.projects.filter(
      (p) => roberta.some((r) => r.code === p.code) && !seen.has(p.code),
    );
    expect(only.length).toBeGreaterThan(0);
    for (const t of [en, it_]) {
      const steps = await respond("which projects are stuck?", as(GIULIA, t));
      const text = everything(steps);
      for (const p of only) {
        expect(text, p.code).not.toMatch(word(p.code));
        expect(text, p.name).not.toContain(p.name.toLowerCase());
      }
      // La prima riga non conta i progetti di Roberta.
      expect(text.split("\n")[0]).not.toMatch(word(String(roberta.length)));
    }
  });

  it("con 8 progetti fermi: 5 righe e «and 3 more · open the list» col link", async () => {
    const eight = (await expectedStalled(ROBERTA)).slice(0, 8).map((r) => r.code);
    keepOnly(eight);
    const text = said(await respond("which projects are stuck?", as(ROBERTA)));
    expect(text.split("\n")[0]).toBe("8 projects have stalled tasks");
    expect(bullets(text)).toHaveLength(5);
    expect(text.trimEnd().split("\n").at(-1)).toBe(
      "and 3 more · [open the list](#/projects?view=stalled)",
    );
    expect(isAppRoute("#/projects?view=stalled")).toBe(true);
  });

  it("un solo progetto fermo: una riga sola, senza elenco", async () => {
    keepOnly(["ACQ"]);
    stallManually("ACQ", 4, 12);
    const steps = await respond("which projects are stuck?", as(ROBERTA));
    expect(said(steps)).toBe(
      "ACQ has 4 stalled tasks, the oldest for 12 days (marked stuck: waiting for the supplier)",
    );
    expect(bullets(said(steps))).toEqual([]);
    const it = said(await respond("quali progetti sono fermi?", as(ROBERTA, it_)));
    expect(it).toBe(
      "ACQ ha 4 task ferme, la più vecchia da 12 giorni (segnata ferma: waiting for the supplier)",
    );
  });

  it("una task sola: «ACQ has 1 stalled task, for 12 days (…)»", async () => {
    keepOnly(["ACQ"]);
    stallManually("ACQ", 1, 12);
    expect(said(await respond("which projects are stuck?", as(ROBERTA)))).toBe(
      "ACQ has 1 stalled task, for 12 days (marked stuck: waiting for the supplier)",
    );
  });

  it("nessun progetto fermo: una riga, niente «Details»", async () => {
    keepOnly(["ACQ"]);
    const steps = await respond("which projects are stuck?", as(ROBERTA));
    expect(said(steps)).toBe("No project has stalled tasks");
    expect(events(steps, "aside")).toEqual([]);
  });

  it("l'ipotesi: un `aside` a sé, mai nel testo, solo con le sue condizioni", async () => {
    keepOnly(["ACQ"]);
    const [task] = stallManually("ACQ", 1, 12);
    // Senza le condizioni (il motivo è a mano): nessuna ipotesi.
    let steps = await respond("which projects are stuck?", as(ROBERTA));
    expect(asides(steps, "hypothesis")).toEqual([]);
    // La più vecchia non cambia ed è senza settimana: l'ipotesi, col suo codice.
    const active = state.tasks.find(
      (t) => t.projectId === projectId("ACQ") && familyOf(t) === "active",
    );
    expect(active, "una task in corso in ACQ").toBeDefined();
    task!.manualStall = null;
    Object.assign(active!, {
      manualStall: null,
      assigneeId: ROBERTA,
      claude: "none",
      plannedWeek: null,
      lastActivityAt: `${daysFromToday(-30)}T09:00:00Z`,
    });
    steps = await respond("which projects are stuck?", as(ROBERTA));
    const [hypothesis] = asides(steps, "hypothesis");
    expect(hypothesis!.text).toBe(
      `${active!.code} may have fallen out of planning: it has no week`,
    );
    expect(said(steps)).not.toMatch(/planning|hypothesis/i);
    expect(said(steps).split("\n")[0]).not.toContain(active!.code + " may");
    // Al più una Hypothesis e un Details, in quest'ordine, dopo il testo.
    const kinds = steps.flatMap((s) =>
      s.step === "say" ? ["say"] : s.step === "event" ? [`${s.event.type}`] : [],
    );
    expect(kinds).toEqual(["say", "aside", "aside", "citation"]);
    expect(events(steps, "aside").map((a) => a.kind)).toEqual(["hypothesis", "details"]);
    // Con una settimana: niente ipotesi.
    active!.plannedWeek = "2026-W43";
    steps = await respond("which projects are stuck?", as(ROBERTA));
    expect(asides(steps, "hypothesis")).toEqual([]);
  });

  it("i «Details» dicono la soglia, o che le soglie cambiano", async () => {
    keepOnly(["MKX", "AUD"]);
    for (const code of ["MKX", "AUD"])
      state.projectsById.get(projectId(code))!.stallThresholds.activeDays = 7;
    const steps = await respond("which projects are stuck?", as(GIULIA));
    const first = (await expectedStalled(GIULIA))[0]!.code;
    const days = state.projectsById.get(projectId(first))!.stallThresholds.activeDays;
    expect(asides(steps, "details")[0]!.text).toBe(
      `A task counts as stalled when it hasn't changed for longer than its project's threshold (${first}: ${days} days). Only open projects.`,
    );
    state.projectsById.get(projectId("AUD"))!.stallThresholds.activeDays = 3;
    const mixed = await respond("which projects are stuck?", as(GIULIA));
    expect(asides(mixed, "details")[0]!.text).toContain("Thresholds differ by project");
  });

  it("la persona della decisione e la task che blocca, solo se chi chiede le vede", async () => {
    const mkx = projectId("MKX");
    const open = state.tasks.filter((t) => t.projectId === mkx && familyOf(t) !== "closed");
    const [task, blocker] = open;
    task!.manualStall = null;
    const ask = (askedOfId: string) =>
      state.decisions.push({
        id: `dr-${askedOfId}`,
        taskId: task!.id,
        askedById: GIULIA,
        askedOfId,
        question: "?",
        options: ["A"],
        createdAt: "2026-01-01T09:00:00Z",
        withdrawnAt: null,
        answer: null,
      });
    const question = "Which tasks are stalled in MKX, and why?";
    ask(ROBERTA);
    expect(said(await respond(question, as(GIULIA, en, mkx)))).toContain(
      "(waiting for Roberta Fontana's decision)",
    );
    state.decisions.pop();
    const { visiblePeopleFor } = await import("../../data/access/whoCan");
    const hidden = PEOPLE.find((p) => !p.isClaude && !visiblePeopleFor(GIULIA).has(p.id))!;
    ask(hidden.id);
    const blind = everything(await respond(question, as(GIULIA, en, mkx)));
    expect(blind).toContain("(waiting for a decision)");
    expect(blind).not.toContain(hidden.name.toLowerCase());
    state.decisions.pop();
    // La task che blocca: col suo codice.
    blocker!.links = [...blocker!.links, { kind: "blocks", taskId: task!.id }];
    task!.lastActivityAt = "2026-01-01T09:00:00Z";
    expect(said(await respond(question, as(GIULIA, en, mkx)))).toContain(
      `(blocked by ${blocker!.code})`,
    );
  });
});

describe("S2 ristretto al progetto del contesto (P16, [SG 3])", () => {
  it("Giulia dall'Overview di MKX: solo le ferme di MKX, i numeri di `stallOf` su MKX", async () => {
    const [mkx] = await expectedStalled(GIULIA, "MKX");
    const others = (await expectedStalled(GIULIA)).filter((r) => r.code !== "MKX");
    for (const [text, t] of [
      ["Which tasks are stalled in MKX, and why?", en],
      ["Quali task sono ferme in MKX, e perché?", it_],
      // Una domanda generale fatta dall'Overview: la stessa risposta ristretta (P16).
      ["which projects are stuck?", en],
    ] as const) {
      const steps = await respond(text, as(GIULIA, t, projectId("MKX")));
      const answer = said(steps);
      expect(answer).toBe(
        t === en
          ? `MKX has ${mkx!.stalled} stalled tasks, the oldest for ${mkx!.days} days (${answer.match(/\(([^)]*)\)$/)![1]})`
          : `MKX ha ${mkx!.stalled} task ferme, la più vecchia da ${mkx!.days} giorni (${answer.match(/\(([^)]*)\)$/)![1]})`,
      );
      for (const o of others) expect(everything(steps), o.code).not.toMatch(word(o.code));
    }
  });

  it("Laura dall'Overview di ACQ: le ferme di ACQ, e nessun altro progetto", async () => {
    stallManually("ACQ", 3, 9);
    const [acq] = await expectedStalled(LAURA, "ACQ");
    const steps = await respond(
      "Quali task sono ferme in ACQ, e perché?",
      as(LAURA, it_, projectId("ACQ")),
    );
    expect(said(steps)).toBe(
      `ACQ ha ${acq!.stalled} task ferme, la più vecchia da ${acq!.days} giorni (segnata ferma: waiting for the supplier)`,
    );
    const others = (await expectedStalled(LAURA)).filter((r) => r.code !== "ACQ");
    for (const o of others) expect(everything(steps), o.code).not.toMatch(word(o.code));
  });

  it("un progetto che non vede risponde come uno che non esiste", async () => {
    const hidden = said(await respond("Which tasks are stalled in LNT?", as(GIULIA)));
    const missing = said(await respond("Which tasks are stalled in ZZZ?", as(GIULIA)));
    expect(hidden).toBe("Can't find the project LNT.");
    expect(hidden.replace("LNT", "ZZZ")).toBe(missing);
  });
});

describe("S3, la spesa del mese", () => {
  it("Roberta: il totale col budget, i 3 che spendono di più, Consumi", async () => {
    setSessionPersonId(ROBERTA);
    const usage = await api.instance.getUsage({ range: { month: true }, groupBy: "project" });
    const top = usage.rows.filter((r) => r.key !== null).slice(0, 3);
    const steps = await respond("How much have we spent on AI this month?", as(ROBERTA));
    const text = said(steps);
    expect(text.split("\n")[0]).toBe(
      `We've spent ${usd(usage.totals.costUsd, "en", "always")} on AI this month, of a ${usd(600, "en")} budget.`,
    );
    expect(bullets(text)).toEqual(
      top.map((r) => `- **${r.code}** — ${usd(r.costUsd, "en", "always")}`),
    );
    expect(text).toContain("[Open Usage →](#/admin/ai?tab=usage)");
    // Lo stesso indirizzo di «Open Usage» in Progetto → Settings → Usage (`UsageSettings`).
    expect(text).not.toMatch(/%/);
    const it = said(await respond("quanto abbiamo speso in AI questo mese?", as(ROBERTA, it_)));
    expect(it.split("\n")[0]).toBe(
      `Questo mese abbiamo speso ${usd(usage.totals.costUsd, "it", "always")} in AI, su un budget di ${usd(600, "it")}.`,
    );
    // I «Details»: dal 1° del mese a `now()`.
    expect(asides(steps, "details")[0]!.text).toMatch(
      /^From Oct 1 to Oct 23, 12:00\. The same totals as Usage\.$/,
    );
  });

  it("Roberta: «Other projects» quando spende un progetto che non è più aperto", async () => {
    for (const code of ["AUD", "STW", "CBV"])
      state.projectsById.get(projectId(code))!.archived = { at: now(), byId: ROBERTA };
    const text = said(await respond("How much have we spent on AI this month?", as(ROBERTA)));
    expect(bullets(text)[0]).toMatch(/^- Other projects — \$/);
    expect(text).not.toMatch(word("AUD"));
  });

  it("Laura: la somma dei suoi progetti, nessun totale d'istanza, «Who?» d'istanza", async () => {
    setSessionPersonId(LAURA);
    let total = 0;
    for (const p of await api.listProjects()) {
      if (!can(viewerFor(LAURA), "project.usage.view", p.id)) continue;
      const u = await api.projectSettings.getProjectUsage(p.id, {
        range: { month: true },
        groupBy: "day",
      });
      total += u!.totals.costUsd;
    }
    total = Math.round(total * 1e6) / 1e6;
    setSessionPersonId(ROBERTA);
    const instance = await api.instance.getUsage({ range: { month: true }, groupBy: "project" });
    const steps = await respond("How much have we spent on AI this month?", as(LAURA));
    const text = said(steps);
    expect(text.split("\n")[0]).toBe(
      `In the projects whose usage you can see: ${usd(total, "en", "always")}.`,
    );
    expect(text).not.toContain(usd(instance.totals.costUsd, "en", "always"));
    expect(text).not.toMatch(/other projects|in total|in tutto|di più/i);
    expect(text.trimEnd().split("\n").at(-1)).toBe(
      "The total is visible to people who can see usage · [Who?](who:seeUsage)",
    );
    const it = said(await respond("quanto abbiamo speso in AI questo mese?", as(LAURA, it_)));
    expect(it.split("\n")[0]).toBe(
      `Nei progetti di cui vedi i consumi: ${usd(total, "it", "always")}.`,
    );
    expect(it.trimEnd().split("\n").at(-1)).toBe(
      "Il totale lo vede chi può vedere i consumi · [Who?](who:seeUsage)",
    );
  });

  it("Sara: la riga `none`", async () => {
    const steps = await respond("How much have we spent on AI this month?", as(SARA));
    expect(said(steps)).toBe("You can't see the usage of any project · [Who?](who:seeUsage)");
    expect(events(steps, "aside")).toEqual([]);
    expect(said(await respond("quanto abbiamo speso in AI questo mese?", as(SARA, it_)))).toBe(
      "Non vedi i consumi di nessun progetto · [Who?](who:seeUsage)",
    );
  });

  it("«Quanto spende Roberta?»: il dato che manca, nessuna cifra", async () => {
    for (const [text, t, line] of [
      ["Quanto spende Roberta?", it_, "Non ho i consumi per persona."],
      ["How much does Roberta spend on AI?", en, "I don't have usage per person."],
    ] as const) {
      for (const who of [ROBERTA, SARA]) {
        const steps = await respond(text, as(who, t));
        expect(said(steps)).toBe(line);
        expect(everything(steps)).not.toMatch(/\d|\$/);
        expect(events(steps, "aside")).toEqual([]);
      }
    }
  });

  it("il mese si misura su `now()`: al mese dopo la spesa riparte", async () => {
    const start = Date.parse(now());
    advanceNow(Date.UTC(2026, 10, 2, 10, 41) - start);
    const steps = await respond("How much have we spent on AI this month?", as(ROBERTA));
    expect(said(steps).split("\n")[0]).toBe(
      `We've spent $0 on AI this month, of a ${usd(600, "en")} budget.`,
    );
    expect(asides(steps, "details")[0]!.text).toBe(
      "From Nov 1 to Nov 2, 10:41. The same totals as Usage.",
    );
  });
});
