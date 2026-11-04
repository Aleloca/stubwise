import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { readsAs } from "../../data/api-mutations";
import { classOfGroup } from "../../data/claude/classes";
import { setSessionPersonId } from "../../data/session";
import { setStreamLatency, visibleProjectIds } from "../../data/store";
import type { ConversationEvent, PageAction, ScriptStep } from "../../data/types";
import { recognize, respond, type IntentContext } from "./intents";

// Le azioni della pagina (area 10b, Task 9): lingua, tema, il filtro della
// pagina sotto, e il filtro salvato personale. Classe A: toccano solo chi
// chiede. Il motore non le esegue: emette un evento `pageAction` `pending`,
// che il riquadro di chi chiede esegue una volta. Nessuna proposta. Nella
// Chat (senza `classify`) nessuno le eseguirebbe: una riga rimanda al
// riquadro (P11). «Questo filtro» è l'ultimo filtro fatto nella
// conversazione (P21). Una domanda «come si fa» resta a `howto` (T6 I1).

const en = i18n.getFixedT("en");
const it_ = i18n.getFixedT("it");
const ROBERTA = "p-roberta";
const LAURA = "p-laura";
const GIULIA = "p-giulia";
const MARCO = "p-marco";
const ACQ = "prj-acq";

type Look = NonNullable<IntentContext["page"]>;
const LIGHT_EN: Look = { theme: "light", language: "en", lastFilter: null };

function as(
  personId: string,
  t = en,
  page: Look | undefined = LIGHT_EN,
  extra: Partial<IntentContext> = {},
): IntentContext {
  setSessionPersonId(personId);
  return {
    personId,
    contextProjectId: null,
    read: readsAs(personId),
    t,
    seed: "conv-10b-page",
    classify: async (actions) => classOfGroup(personId, actions),
    asks: true,
    ...(page ? { page } : {}),
    ...extra,
  };
}

const said = (steps: ScriptStep[]) =>
  steps.flatMap((s) => (s.step === "say" ? [s.text] : [])).join("\n");
type PageEvent = Omit<Extract<ConversationEvent, { type: "pageAction" }>, "id" | "at">;
const pageEvents = (steps: ScriptStep[]): PageEvent[] =>
  steps.flatMap((s) =>
    s.step === "event" && s.event.type === "pageAction" ? [s.event as unknown as PageEvent] : [],
  );
const kinds = (steps: ScriptStep[]) =>
  steps.flatMap((s) => (s.step === "event" ? [s.event.type] : []));
const onlyPage = (steps: ScriptStep[]): PageAction => {
  const events = pageEvents(steps);
  expect(events).toHaveLength(1);
  expect(events[0]!.status).toBe("pending");
  // Mai una scheda: un'azione della pagina è sempre A.
  expect(kinds(steps)).not.toContain("proposal");
  expect(kinds(steps)).not.toContain("executed");
  return events[0]!.action;
};

beforeEach(() => {
  api.setLatency(0);
  setStreamLatency(0);
  api.resetApi();
  void i18n.changeLanguage("en");
});
afterEach(() => void i18n.changeLanguage("en"));

describe("recognize: le azioni della pagina", () => {
  it("tema, lingua, filtro e filtro salvato, en e it", () => {
    for (const text of [
      "passa al tema scuro",
      "Passa al tema chiaro",
      "metti il tema del sistema",
      "Puoi passare al tema scuro?",
      "dark theme",
      "Dark mode, please",
      "switch to dark mode",
      "switch to the light theme",
      "use the system theme",
      "metti l'interfaccia in inglese",
      "passa all'italiano",
      "switch to Italian",
      "change the language to English",
      "mostrami le task di Marco in ACQ",
      "mostrami le task ferme in ACQ",
      "show ACQ tasks assigned to Marco",
      "show me my tasks in ACQ",
      "filter ACQ tasks by Marco",
      "salva questo filtro come Marco in ACQ",
      "save this filter as Marco in ACQ",
    ]) {
      expect(recognize(text, new Set(["ACQ"])), text).toBe("page");
    }
  });

  it("«show ACQ tasks…» e «passa al tema scuro» non sono `explain` né un comando (P10)", () => {
    expect(recognize("show ACQ tasks assigned to Marco", new Set(["ACQ"]))).toBe("page");
    expect(recognize("passa al tema scuro", new Set(["ACQ"]))).toBe("page");
  });

  it("una domanda «come si fa» resta a `howto`, en e it (il controllo unico, T6 I1)", () => {
    for (const text of [
      "how do I change the theme?",
      "How can I switch to dark mode?",
      "how to show ACQ tasks assigned to Marco?",
      "come si cambia la lingua?",
      "Come posso passare al tema scuro?",
      "come faccio a salvare questo filtro?",
    ]) {
      expect(recognize(text, new Set(["ACQ"])), text).toBe("howto");
    }
  });

  it("non sono azioni della pagina: domande, altri comandi, bozze, segreti", () => {
    const cases: [string, string][] = [
      ["create a task for the dark theme in ACQ", "create"],
      ["crea una task per il tema scuro in ACQ", "create"],
      ["Show me the webhook secret of AUD", "refused"],
      ["Which tasks are stalled in ACQ?", "stalled"],
      ["scrivi la risposta in inglese", "draft"],
      ["what theme am I using?", "general"],
      ["is the interface in English?", "general"],
    ];
    for (const [text, intent] of cases) {
      expect(recognize(text, new Set(["ACQ", "AUD"])), text).toBe(intent);
    }
  });
});

describe("il tema e la lingua", () => {
  it("«passa al tema scuro» / «dark theme»: un `pageAction` tema, nessun testo né scheda", async () => {
    for (const [text, t] of [
      ["passa al tema scuro", it_],
      ["dark theme", en],
    ] as const) {
      const steps = await respond(text, as(LAURA, t));
      expect(onlyPage(steps), text).toEqual({ kind: "theme", to: "dark" });
      expect(said(steps)).toBe("");
    }
    expect(onlyPage(await respond("use the system theme", as(LAURA)))).toEqual({
      kind: "theme",
      to: "system",
    });
  });

  it("col tema già scuro risponde che lo è già, e non nasce niente", async () => {
    const dark: Look = { theme: "dark", language: "en", lastFilter: null };
    const steps = await respond("switch to dark mode", as(LAURA, en, dark));
    expect(pageEvents(steps)).toEqual([]);
    expect(said(steps)).toBe("The theme is already dark.");
    const it = await respond("passa al tema scuro", as(LAURA, it_, { ...dark, language: "it" }));
    expect(said(it)).toBe("Il tema è già scuro.");
  });

  it("«metti l'interfaccia in inglese», «switch to Italian»: la lingua; già quella, lo dice", async () => {
    const italian: Look = { theme: "light", language: "it", lastFilter: null };
    expect(
      onlyPage(await respond("metti l'interfaccia in inglese", as(LAURA, it_, italian))),
    ).toEqual({ kind: "language", to: "en" });
    expect(onlyPage(await respond("switch to Italian", as(LAURA)))).toEqual({
      kind: "language",
      to: "it",
    });
    const steps = await respond("switch to English", as(LAURA));
    expect(pageEvents(steps)).toEqual([]);
    expect(said(steps)).toBe("The interface is already in English.");
  });

  it("nella Chat (senza `classify`) nessuno la eseguirebbe: una riga rimanda al riquadro (P11)", async () => {
    const steps = await respond("dark theme", as(LAURA, en, LIGHT_EN, { classify: undefined }));
    expect(pageEvents(steps)).toEqual([]);
    expect(said(steps)).toBe(en("claude.answers.page.inPanel"));
    expect(said(steps)).toMatch(/Claude panel/);
  });
});

describe("il filtro della pagina sotto", () => {
  it("«mostrami le task di Marco in ACQ» e «show ACQ tasks assigned to Marco»: Tasks di ACQ coi criteri", async () => {
    for (const [text, t] of [
      ["mostrami le task di Marco in ACQ", it_],
      ["show ACQ tasks assigned to Marco", en],
    ] as const) {
      expect(onlyPage(await respond(text, as(ROBERTA, t))), text).toEqual({
        kind: "filter",
        route: "/p/ACQ/tasks",
        search: { filters: { assigneeIds: [MARCO], families: ["todo", "active"] } },
      });
    }
  });

  it("«ferme» / «stalled» e «le mie»: i criteri che li dicono", async () => {
    expect(onlyPage(await respond("mostrami le task ferme in ACQ", as(ROBERTA, it_)))).toEqual({
      kind: "filter",
      route: "/p/ACQ/tasks",
      search: { filters: { families: ["todo", "active"], stalled: true } },
    });
    expect(onlyPage(await respond("show me my tasks in ACQ", as(LAURA)))).toEqual({
      kind: "filter",
      route: "/p/ACQ/tasks",
      search: { filters: { assigneeIds: [LAURA], families: ["todo", "active"] } },
    });
  });

  it("senza progetto vale quello del contesto; senza nessuno, Claude chiede quale", async () => {
    const ctx = as(ROBERTA, en, LIGHT_EN, { contextProjectId: ACQ });
    expect(onlyPage(await respond("show tasks assigned to Marco", ctx))).toMatchObject({
      route: "/p/ACQ/tasks",
    });
    const none = await respond("show tasks assigned to Marco", as(ROBERTA));
    expect(pageEvents(none)).toEqual([]);
    expect(said(none)).toBe(en("claude.answers.page.noProject"));
  });

  it("un progetto che chi chiede non vede risponde come uno che non esiste (R-G5)", async () => {
    setSessionPersonId(GIULIA);
    expect(visibleProjectIds(GIULIA).has(ACQ)).toBe(false);
    const hidden = await respond("show ACQ tasks assigned to Marco", as(GIULIA));
    const missing = await respond("show ZZZ tasks assigned to Marco", as(GIULIA));
    expect(pageEvents(hidden)).toEqual([]);
    expect(said(hidden)).toBe(said(missing).replace("ZZZ", "ACQ"));
    expect(said(hidden).toLowerCase()).not.toContain("acquario");
  });
});

describe("il filtro salvato («questo filtro», P21)", () => {
  const LAST = {
    route: "/p/ACQ/tasks",
    search: { filters: { assigneeIds: [MARCO], families: ["todo", "active"] } },
  };

  it("dopo un filtro fatto: `saveFilter` privato coi suoi criteri e il progetto, eseguito (A)", async () => {
    const ctx = as(LAURA, it_, { theme: "light", language: "it", lastFilter: LAST });
    const steps = await respond("salva questo filtro come Marco in ACQ", ctx);
    const executed = steps.flatMap((s) =>
      s.step === "event" && s.event.type === "executed" ? [s.event] : [],
    );
    expect(executed).toHaveLength(1);
    expect(executed[0]!.actions).toHaveLength(1);
    expect(executed[0]!.actions[0]).toMatchObject({
      fn: "saveFilter",
      args: {
        name: "Marco in ACQ",
        visibility: "private",
        criteria: { projectIds: [ACQ], assigneeIds: [MARCO], families: ["todo", "active"] },
      },
    });
    expect(kinds(steps)).not.toContain("proposal");
    expect(pageEvents(steps)).toEqual([]);
  });

  it("il nome fra virgolette, in inglese", async () => {
    const ctx = as(LAURA, en, { ...LIGHT_EN, lastFilter: LAST });
    const steps = await respond('save this filter as "Marco · ACQ"', ctx);
    const action = steps.flatMap((s) =>
      s.step === "event" && s.event.type === "executed" ? s.event.actions : [],
    )[0];
    expect(action?.args).toMatchObject({ name: "Marco · ACQ" });
  });

  it("senza un filtro prima: la riga che lo chiede, e nessun `saveFilter`", async () => {
    const steps = await respond("salva questo filtro come Marco in ACQ", as(LAURA, it_));
    expect(kinds(steps)).not.toContain("executed");
    expect(kinds(steps)).not.toContain("proposal");
    expect(said(steps)).toBe(it_("claude.answers.page.needFilter"));
  });

  it("senza un nome: Claude lo chiede", async () => {
    const ctx = as(LAURA, en, { ...LIGHT_EN, lastFilter: LAST });
    const steps = await respond("save this filter", ctx);
    expect(kinds(steps)).not.toContain("executed");
    expect(said(steps)).toBe(en("claude.answers.page.needName"));
  });
});
