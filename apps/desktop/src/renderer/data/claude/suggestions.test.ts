import i18n from "i18next";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../api";
import { readsAs } from "../api-mutations";
import { classOfGroup } from "./classes";
import { daysFromToday } from "../dates";
import { PEOPLE } from "../seed/people";
import { setSessionPersonId } from "../session";
import { familyOf, state, visibleProjectIds } from "../store";
import type { ScriptStep } from "../types";
import { recognize, respond } from "../../domain/claude/intents";
import {
  suggestionFor,
  suggestionKeyOf,
  type ClaudeSuggestion,
  type SuggestionPlace,
} from "./suggestions";

// I suggerimenti discreti «Claude can help you…» (area 10b, Task 12; shape
// `claude-suggestions.md`): il livello dati decide se una pagina ha la riga
// e quale, per chi guarda. Mai senza il permesso di fare ciò che la riga
// propone (nessun «Who?»), mai accanto a un piano, una domanda o una
// proposta aperti, mai col budget del mese esaurito ([SG 5], P16), e mai un
// codice o un nome che chi guarda non vede (R-G5, in minuscolo).

const en = i18n.getFixedT("en");
const it_ = i18n.getFixedT("it");
const DAVIDE = "p-davide";
const SARA = "p-sara";
const LAURA = "p-laura";
const GIULIA = "p-giulia";
const ROBERTA = "p-roberta";
const ACQ = "prj-acq";
const MKX = "prj-mkx";
const ACQ_S2 = "sup-acq-2";
const ACQ_PR = "opr-acq-77";

const conv = (id: string) => state.supportConversations.find((c) => c.id === id)!;
const pr = (id: string) => state.openPrs.find((p) => p.id === id)!;
const taskId = (code: string) => state.tasks.find((t) => t.code === code)!.id;

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
});

/** Rende ferma a mano una task aperta del progetto. */
function stallOne(projectId: string) {
  const task = state.tasks.find((t) => t.projectId === projectId && familyOf(t) !== "closed")!;
  task.manualStall = {
    reason: "waiting for the supplier",
    note: "",
    since: daysFromToday(-9),
    byId: ROBERTA,
  };
  return task;
}

/** Una proposta del polso aperta sul progetto: la card `project.pulse` non archiviata. */
function openPulseProposal(projectId: string) {
  state.notifications.push({
    id: "n-pulse-test",
    kind: "project.pulse",
    projectId,
    objectCode: state.projectsById.get(projectId)!.code,
    departmentId: null,
    recipientIds: [],
    title: "Proposal for an idle project",
    body: "",
    createdAt: "2026-10-20T09:00:00Z",
    read: false,
    archived: false,
    snoozedUntil: null,
    link: "#/home",
  });
}

/** La riga e la richiesta di un suggerimento, nella lingua `t`. */
const textOf = (s: ClaudeSuggestion, t = en) =>
  `${t("claude.suggestions.lead")}${t(s.lineKey, s.params)}\n${t(s.promptKey, s.params)}`;

describe("le cinque righe di partenza: c'è col permesso, non c'è senza", () => {
  it("support: Davide su ACQ-S2 (aspetta il team) sì; Sara (senza support.reply) no", () => {
    expect(suggestionFor(DAVIDE, { kind: "support", conversationId: ACQ_S2 })).toEqual({
      id: "supportReply",
      lineKey: "claude.suggestions.supportReply.line",
      promptKey: "claude.suggestions.supportReply.prompt",
      params: { code: "ACQ-S2", context: "vowel" },
    });
    expect(suggestionFor(SARA, { kind: "support", conversationId: ACQ_S2 })).toBeNull();
  });

  it("support: una conversazione che non aspetta il team non ha la riga; quando aspetta, sì", () => {
    const place: SuggestionPlace = { kind: "support", conversationId: "sup-acq-4" };
    expect(suggestionFor(DAVIDE, place)).toBeNull();
    // Il cliente scrive ancora: ora aspetta il team.
    const c = conv("sup-acq-4");
    c.messages.push({
      ...c.messages.find((m) => m.from === "customer")!,
      id: "m-test",
      at: "2026-10-23T11:00:00Z",
    });
    expect(suggestionFor(DAVIDE, place)?.params).toEqual({ code: "ACQ-S4", context: "vowel" });
  });

  it("pr: Laura sulla PR di ACQ senza note sì; Sara (senza tickets.edit né release.merge) no; con le note no", () => {
    expect(suggestionFor(LAURA, { kind: "pr", prId: ACQ_PR })).toEqual({
      id: "releaseNotes",
      lineKey: "claude.suggestions.releaseNotes.line",
      promptKey: "claude.suggestions.releaseNotes.prompt",
    });
    expect(suggestionFor(SARA, { kind: "pr", prId: ACQ_PR })).toBeNull();
    pr(ACQ_PR).releaseNotes = "- ACQ-7: Reminder";
    expect(suggestionFor(LAURA, { kind: "pr", prId: ACQ_PR })).toBeNull();
    // Note di soli spazi: come nessuna nota.
    pr(ACQ_PR).releaseNotes = "  \n";
    expect(suggestionFor(LAURA, { kind: "pr", prId: ACQ_PR })).not.toBeNull();
  });

  it("automations: Laura su ACQ (nessuna automazione) sì; Sara (senza automations.manage) no; AUD (ne ha una) no", () => {
    expect(suggestionFor(LAURA, { kind: "automations", projectId: ACQ })).toEqual({
      id: "buildAutomation",
      lineKey: "claude.suggestions.buildAutomation.line",
      promptKey: "claude.suggestions.buildAutomation.prompt",
      params: { code: "ACQ" },
    });
    expect(suggestionFor(SARA, { kind: "automations", projectId: ACQ })).toBeNull();
    expect(suggestionFor(LAURA, { kind: "automations", projectId: "prj-aud" })).toBeNull();
  });

  it("overview: Giulia su MKX (task ferme) sì; su ACQ, che non vede, no; Laura su ACQ senza task ferme no", () => {
    expect(suggestionFor(GIULIA, { kind: "overview", projectId: MKX })).toEqual({
      id: "whyStalled",
      lineKey: "claude.suggestions.whyStalled.line",
      promptKey: "claude.suggestions.whyStalled.prompt",
      params: { code: "MKX" },
    });
    expect(suggestionFor(LAURA, { kind: "overview", projectId: ACQ })).toBeNull();
    stallOne(ACQ);
    expect(suggestionFor(LAURA, { kind: "overview", projectId: ACQ })?.params).toEqual({
      code: "ACQ",
    });
    // Giulia non vede ACQ: come un progetto che non c'è (R-G5).
    expect(suggestionFor(GIULIA, { kind: "overview", projectId: ACQ })).toBeNull();
    expect(suggestionFor(GIULIA, { kind: "overview", projectId: "prj-none" })).toBeNull();
  });

  it("usage: Roberta (usage.view) sì; Laura no", () => {
    expect(suggestionFor(ROBERTA, { kind: "usage" })).toEqual({
      id: "monthSpend",
      lineKey: "claude.suggestions.monthSpend.line",
      promptKey: "claude.suggestions.monthSpend.prompt",
    });
    expect(suggestionFor(LAURA, { kind: "usage" })).toBeNull();
  });

  it("un oggetto che chi guarda non vede, o che non c'è, non ha la riga", () => {
    expect(suggestionFor(GIULIA, { kind: "support", conversationId: ACQ_S2 })).toBeNull();
    expect(suggestionFor(GIULIA, { kind: "pr", prId: ACQ_PR })).toBeNull();
    expect(suggestionFor(GIULIA, { kind: "automations", projectId: ACQ })).toBeNull();
    expect(suggestionFor(DAVIDE, { kind: "support", conversationId: "sup-none" })).toBeNull();
    expect(suggestionFor(LAURA, { kind: "pr", prId: "opr-none" })).toBeNull();
  });
});

describe("il «mai se»", () => {
  it("la PR la cui task ha un piano in attesa non ha la riga", () => {
    // STW-13 ha un piano che aspetta una decisione (seme).
    expect(suggestionFor(LAURA, { kind: "pr", prId: ACQ_PR })).not.toBeNull();
    pr(ACQ_PR).taskId = taskId("STW-13");
    expect(suggestionFor(LAURA, { kind: "pr", prId: ACQ_PR })).toBeNull();
  });

  it("la PR la cui task ha una domanda aperta non ha la riga (di Claude e di una persona)", () => {
    // AUD-3: una domanda di Claude senza risposta (seme).
    pr(ACQ_PR).taskId = taskId("AUD-3");
    expect(suggestionFor(LAURA, { kind: "pr", prId: ACQ_PR })).toBeNull();
    // STW-4: una richiesta di decisione aperta fra persone (seme).
    pr(ACQ_PR).taskId = taskId("STW-4");
    expect(suggestionFor(LAURA, { kind: "pr", prId: ACQ_PR })).toBeNull();
  });

  it("un progetto con una proposta del polso aperta non ha la riga dell'Overview; archiviata, torna", () => {
    expect(suggestionFor(GIULIA, { kind: "overview", projectId: MKX })).not.toBeNull();
    openPulseProposal(MKX);
    expect(suggestionFor(GIULIA, { kind: "overview", projectId: MKX })).toBeNull();
    state.notifications.at(-1)!.archived = true;
    expect(suggestionFor(GIULIA, { kind: "overview", projectId: MKX })).not.toBeNull();
  });
});

describe("budget mensile esaurito (P16, [SG 5])", () => {
  it("nessuna riga in nessuno dei cinque luoghi", () => {
    stallOne(ACQ);
    const cases: [string, SuggestionPlace][] = [
      [DAVIDE, { kind: "support", conversationId: ACQ_S2 }],
      [LAURA, { kind: "pr", prId: ACQ_PR }],
      [LAURA, { kind: "automations", projectId: ACQ }],
      [LAURA, { kind: "overview", projectId: ACQ }],
      [ROBERTA, { kind: "usage" }],
    ];
    for (const [me, place] of cases) expect(suggestionFor(me, place)).not.toBeNull();
    state.instance.simulate.budgetReached = true;
    for (const [me, place] of cases) expect(suggestionFor(me, place)).toBeNull();
  });
});

describe("la chiave del luogo è l'oggetto", () => {
  it("support:<id>, pr:<id>, automations:<id>, overview:<id>, usage", () => {
    expect(suggestionKeyOf({ kind: "support", conversationId: ACQ_S2 })).toBe("support:sup-acq-2");
    expect(suggestionKeyOf({ kind: "pr", prId: ACQ_PR })).toBe("pr:opr-acq-77");
    expect(suggestionKeyOf({ kind: "automations", projectId: ACQ })).toBe("automations:prj-acq");
    expect(suggestionKeyOf({ kind: "overview", projectId: ACQ })).toBe("overview:prj-acq");
    expect(suggestionKeyOf({ kind: "usage" })).toBe("usage");
  });
});

describe("i testi", () => {
  it("le cinque righe e richieste dello shape, en e it, con «ad» davanti a una vocale", () => {
    stallOne(ACQ);
    const rows = [
      suggestionFor(DAVIDE, { kind: "support", conversationId: ACQ_S2 })!,
      suggestionFor(LAURA, { kind: "pr", prId: ACQ_PR })!,
      suggestionFor(LAURA, { kind: "automations", projectId: ACQ })!,
      suggestionFor(LAURA, { kind: "overview", projectId: ACQ })!,
      suggestionFor(ROBERTA, { kind: "usage" })!,
    ];
    expect(rows.map((s) => textOf(s, en))).toEqual([
      "Claude can help you write the reply\nWrite the reply to ACQ-S2",
      "Claude can help you write the release notes\nWrite the release notes",
      "Claude can help you build an automation for ACQ\nBuild an automation in ACQ: when ",
      "Claude can help you understand why ACQ is stalled\nWhich tasks are stalled in ACQ, and why?",
      "Claude can help you summarize this month's spend\nHow much have we spent on AI this month?",
    ]);
    expect(rows.map((s) => textOf(s, it_))).toEqual([
      "Claude può aiutarti a scrivere la risposta\nScrivi la risposta ad ACQ-S2",
      "Claude può aiutarti a scrivere le note di rilascio\nScrivi le note di rilascio",
      "Claude può aiutarti a costruire un'automazione per ACQ\nCostruisci un'automazione in ACQ: quando ",
      "Claude può aiutarti a capire perché ACQ è fermo\nQuali task sono ferme in ACQ, e perché?",
      "Claude può aiutarti a riassumere la spesa del mese\nQuanto abbiamo speso in AI questo mese?",
    ]);
    // Un codice che comincia con una consonante: «a», non «ad».
    expect(it_("claude.suggestions.supportReply.prompt", { code: "MKX-S1" })).toBe(
      "Scrivi la risposta a MKX-S1",
    );
  });

  it("R-G5: nessun codice o nome che chi guarda non vede, mai un «Who?» (in minuscolo)", () => {
    const cases: [string, SuggestionPlace][] = [
      [DAVIDE, { kind: "support", conversationId: ACQ_S2 }],
      [LAURA, { kind: "pr", prId: ACQ_PR }],
      [LAURA, { kind: "automations", projectId: ACQ }],
      [GIULIA, { kind: "overview", projectId: MKX }],
      [ROBERTA, { kind: "usage" }],
    ];
    for (const [me, place] of cases) {
      const s = suggestionFor(me, place)!;
      const visible = visibleProjectIds(me);
      for (const t of [en, it_]) {
        const text = textOf(s, t).toLowerCase();
        expect(text).not.toMatch(/\bwho\b|chi può/);
        for (const p of state.projects.filter((x) => !visible.has(x.id))) {
          expect(text).not.toMatch(new RegExp(`(^|[^a-z0-9])${p.code.toLowerCase()}([^a-z0-9]|$)`));
          expect(text).not.toContain(p.name.toLowerCase());
        }
        // Nessun nome di persona: la riga parla in seconda persona.
        for (const person of PEOPLE.filter((p) => !p.isClaude))
          expect(text).not.toContain(person.name.toLowerCase());
      }
    }
  });
});

describe("la richiesta dell'Overview è ristretta al progetto (P16, [SG 3])", () => {
  it("inviata da Laura su ACQ, risponde solo sulle task ferme di ACQ", async () => {
    stallOne(ACQ);
    const s = suggestionFor(LAURA, { kind: "overview", projectId: ACQ })!;
    for (const t of [en, it_]) {
      setSessionPersonId(LAURA);
      const steps: ScriptStep[] = await respond(t(s.promptKey, s.params), {
        personId: LAURA,
        // Senza il chip: è la richiesta stessa a nominare il progetto.
        contextProjectId: null,
        read: readsAs(LAURA),
        t,
        seed: "conv-suggestion",
        classify: async (actions) => classOfGroup(LAURA, actions),
        asks: true,
      });
      const said = steps
        .flatMap((st) => (st.step === "say" ? [st.text] : []))
        .join("\n")
        .toLowerCase();
      expect(said).toContain("acq");
      // Laura vede altri progetti fermi (STW, AUD…): la risposta non li nomina.
      for (const code of ["stw", "aud", "uff", "grp", "znc"]) {
        expect(said).not.toMatch(new RegExp(`(^|[^a-z0-9])${code}([^a-z0-9]|$)`));
      }
    }
  });
});

describe("ogni richiesta porta allo scenario giusto, en e it", () => {
  it("risposta e note → bozza (S6/S6b), Overview → fermi (S2), Consumi → spesa (S3), automazioni completate → automazione", () => {
    const codes = new Set(["ACQ"]);
    for (const t of [en, it_]) {
      const prompt = (id: string, params?: Record<string, string>) =>
        t(`claude.suggestions.${id}.prompt`, params);
      expect(recognize(prompt("supportReply", { code: "ACQ-S2", context: "vowel" }), codes)).toBe(
        "draft",
      );
      expect(recognize(prompt("releaseNotes"), codes)).toBe("draft");
      expect(recognize(prompt("whyStalled", { code: "ACQ" }), codes)).toBe("stalled");
      expect(recognize(prompt("monthSpend"), codes)).toBe("spend");
      // La richiesta delle automazioni finisce aperta ([SG 2]): la persona scrive l'evento.
      const event =
        t === en ? "a request is created, create a task" : "nasce una richiesta, crea una task";
      expect(recognize(`${prompt("buildAutomation", { code: "ACQ" })}${event}`, codes)).toBe(
        "automation",
      );
    }
  });
});
