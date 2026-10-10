import { describe, expect, it } from "vitest";

import type { AskUserFileResult } from "../../src/pipeline/ask-user.js";
import {
  askUserCheck,
  declaresIdentifier,
  interveneChecks,
  stopPauseChecks,
  isScenarioName,
  planInterveneChecks,
  SCENARIO_NAMES,
} from "./checks.js";

const asked: AskUserFileResult = {
  kind: "question",
  payload: {
    question: "La soglia della spedizione gratuita va sul subtotale prima o dopo il coupon?",
    options: [
      { label: "Prima del coupon", consequence: "cambia buildOrder e i test" },
      { label: "Dopo il coupon", consequence: "il codice resta, si corregge il banner" },
    ],
    allowFreeText: true,
  },
};
const absent: AskUserFileResult = { kind: "absent" };
const malformed: AskUserFileResult = { kind: "malformed", reason: "JSON non parsabile" };

describe("scenari golden", () => {
  it("no-ask è registrato accanto agli altri, e un nome ignoto no", () => {
    expect(SCENARIO_NAMES).toContain("no-ask");
    expect(SCENARIO_NAMES).toContain("ask-user");
    expect(isScenarioName("no-ask")).toBe(true);
    expect(isScenarioName("no-asks")).toBe(false);
  });
});

describe("askUserCheck", () => {
  it("ask-user: passa solo con una domanda valida", () => {
    expect(askUserCheck(asked, "asks").passed).toBe(true);
    expect(askUserCheck(absent, "asks").passed).toBe(false);
    expect(askUserCheck(malformed, "asks").passed).toBe(false);
  });

  it("no-ask: passa con il file-bridge assente", () => {
    const check = askUserCheck(absent, "does-not-ask");
    expect(check.passed).toBe(true);
    expect(check.name).toBe("ask_user NON chiamato");
  });

  it("no-ask: fallisce con una domanda presente, e il dettaglio la riporta", () => {
    const check = askUserCheck(asked, "does-not-ask");
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("prima o dopo il coupon");
  });

  it("no-ask: anche un file-bridge malformato è rosso (il tool è stato chiamato)", () => {
    expect(askUserCheck(malformed, "does-not-ask").passed).toBe(false);
  });
});

describe("declaresIdentifier", () => {
  it("riconosce function, const/let/var ed export { … }", () => {
    expect(declaresIdentifier("export function add(a: number, b: number) {}", "add")).toBe(true);
    expect(declaresIdentifier("export const add = (a, b) => a + b;", "add")).toBe(true);
    expect(declaresIdentifier("function add(a, b) {}\nexport { add };", "add")).toBe(true);
    expect(declaresIdentifier("const x = 1;\nexport { x, add as plus };", "add")).toBe(true);
  });

  it("una parola in un commento o un nome più lungo non è una dichiarazione", () => {
    expect(
      declaresIdentifier("// returns the sum of a and b\nexport function add() {}", "sum"),
    ).toBe(false);
    expect(declaresIdentifier("export function sumAll() {}", "sum")).toBe(false);
    expect(declaresIdentifier("export function checksum() {}", "sum")).toBe(false);
  });
});

const INPUT_ID = "11111111-1111-4111-8111-111111111111";
const toolUse = { type: "tool_use", data: { name: "Read" } };
const input = (interrupt: boolean) => ({ type: "input", data: { inputId: INPUT_ID, interrupt } });
const turnEnd = (subtype: string) => ({
  type: "turn_end",
  data: { subtype, isError: subtype !== "success" },
});

describe("interveneChecks — absorb", () => {
  const base = {
    mode: "absorb" as const,
    inputId: INPUT_ID,
    exitCode: 0,
    timedOut: false,
    delivered: true,
  };
  const source =
    "export function sum(a, b) { return a + b; }\nexport function mul(a, b) { return a * b; }";

  it("passa: input a metà turno, un solo result success, il file ha sum e mul", () => {
    const checks = interveneChecks({
      ...base,
      source,
      events: [toolUse, input(false), turnEnd("success")],
    });
    expect(checks.filter((c) => !c.passed)).toEqual([]);
  });

  it("due result (il messaggio ha aperto un turno nuovo): rosso", () => {
    const checks = interveneChecks({
      ...base,
      source,
      events: [toolUse, input(false), turnEnd("success"), turnEnd("success")],
    });
    expect(checks.find((c) => c.name.startsWith("messaggio assorbito"))!.passed).toBe(false);
  });

  it("input arrivato DOPO il result: non è a metà turno", () => {
    const checks = interveneChecks({
      ...base,
      source,
      events: [toolUse, turnEnd("success"), input(false)],
    });
    expect(checks.find((c) => c.name.startsWith("consegnato a metà turno"))!.passed).toBe(false);
  });

  it("il file non riflette il messaggio (manca mul): rosso", () => {
    const checks = interveneChecks({
      ...base,
      source: "export function sum(a, b) { return a + b; }",
      events: [toolUse, input(false), turnEnd("success")],
    });
    expect(checks.find((c) => c.name.startsWith("il file riflette"))!.passed).toBe(false);
  });

  it("nessun evento input con quell'inputId: rosso", () => {
    const checks = interveneChecks({ ...base, source, events: [toolUse, turnEnd("success")] });
    expect(checks.find((c) => c.name.startsWith("evento input"))!.passed).toBe(false);
  });

  it("deliver ha risposto false (o non è mai stato chiamato): rosso", () => {
    for (const delivered of [false, null]) {
      const checks = interveneChecks({
        ...base,
        delivered,
        source,
        events: [toolUse, input(false), turnEnd("success")],
      });
      expect(checks.find((c) => c.name.startsWith("deliver ha accettato"))!.passed).toBe(false);
    }
  });

  it("timeout o exit non-zero: rossi", () => {
    const checks = interveneChecks({
      ...base,
      exitCode: 1,
      timedOut: true,
      source,
      events: [toolUse, input(false), turnEnd("success")],
    });
    expect(checks.find((c) => c.name === "exit 0")!.passed).toBe(false);
    expect(checks.find((c) => c.name.startsWith("il run finisce entro il timeout"))!.passed).toBe(
      false,
    );
  });
});

describe("interveneChecks — interrupt", () => {
  const base = {
    mode: "interrupt" as const,
    inputId: INPUT_ID,
    exitCode: 0,
    timedOut: false,
    delivered: true,
  };
  const good = "export function add(a, b) { return a + b; }";
  // L'eco del messaggio (e quindi l'evento input) arriva all'inizio del turno
  // rediretto, dopo il result dell'interruzione.
  const events = [toolUse, turnEnd("error_during_execution"), input(true), turnEnd("success")];

  it("passa: interruzione, turno successivo in success, add e non sum", () => {
    expect(interveneChecks({ ...base, source: good, events }).filter((c) => !c.passed)).toEqual([]);
  });

  it("passa anche con l'eco prima del result dell'interruzione", () => {
    const early = [toolUse, input(true), turnEnd("error_during_execution"), turnEnd("success")];
    expect(interveneChecks({ ...base, source: good, events: early }).filter((c) => !c.passed)).toEqual([]);
  });

  it("eco dopo il result finale (o mai): rosso", () => {
    const late = [toolUse, turnEnd("error_during_execution"), turnEnd("success"), input(true)];
    const checks = interveneChecks({ ...base, source: good, events: late });
    expect(checks.find((c) => c.name.startsWith("preso dal CLI"))!.passed).toBe(false);
  });

  it("nessun result error_during_execution: l'interruzione non è arrivata", () => {
    const checks = interveneChecks({
      ...base,
      source: good,
      events: [toolUse, input(true), turnEnd("success")],
    });
    expect(checks.find((c) => c.name.startsWith("interruzione"))!.passed).toBe(false);
  });

  it("l'ultimo result è l'errore: il processo non ha ripreso", () => {
    const checks = interveneChecks({
      ...base,
      source: good,
      events: [toolUse, input(true), turnEnd("error_during_execution")],
    });
    expect(checks.find((c) => c.name.startsWith("il processo resta vivo"))!.passed).toBe(false);
  });

  it("sum ancora dichiarata: la direzione non è cambiata", () => {
    const checks = interveneChecks({
      ...base,
      source: `${good}\nexport function sum(a, b) { return a + b; }`,
      events,
    });
    expect(checks.find((c) => c.name.startsWith("cambio di direzione"))!.passed).toBe(false);
  });

  it("un input senza interrupt non vale come «Ferma e scrivi»", () => {
    const checks = interveneChecks({
      ...base,
      source: good,
      events: [toolUse, input(false), turnEnd("error_during_execution"), turnEnd("success")],
    });
    expect(checks.find((c) => c.name.startsWith("evento input"))!.passed).toBe(false);
  });
});

describe("intervene è uno scenario", () => {
  it("è registrato", () => {
    expect(isScenarioName("intervene")).toBe(true);
    expect(isScenarioName("intervene-plan")).toBe(true);
  });
});

describe("planInterveneChecks — plan-absorb", () => {
  const base = {
    mode: "plan-absorb" as const,
    inputId: INPUT_ID,
    exitCode: 0,
    timedOut: false,
    delivered: true,
    hasPlanShape: true,
  };
  const events = [toolUse, input(false), turnEnd("success")];

  it("passa: consegnato a metà turno, un solo result, il piano ha la sezione delle decisioni", () => {
    expect(planInterveneChecks({ ...base, events }).filter((c) => !c.passed)).toEqual([]);
  });

  it("l'intervento ha sostituito il piano (manca la sezione delle decisioni): rosso", () => {
    const checks = planInterveneChecks({ ...base, hasPlanShape: false, events });
    expect(checks.find((c) => c.name.startsWith("il piano ha ancora"))!.passed).toBe(false);
  });

  it("non consegnato: rosso (lo scenario non ha misurato niente)", () => {
    const checks = planInterveneChecks({ ...base, delivered: false, events: [toolUse, turnEnd("success")] });
    expect(checks.find((c) => c.name.startsWith("deliver ha accettato"))!.passed).toBe(false);
  });
});

describe("planInterveneChecks — plan-grace", () => {
  const base = {
    mode: "plan-grace" as const,
    inputId: INPUT_ID,
    exitCode: 0,
    timedOut: false,
    delivered: false,
    hasPlanShape: true,
  };
  const events = [toolUse, turnEnd("success")];

  it("passa: dopo il primo result l'intervento è rifiutato, un solo result, l'output è il piano", () => {
    expect(planInterveneChecks({ ...base, events }).filter((c) => !c.passed)).toEqual([]);
  });

  it("consegnato nella grazia: rosso", () => {
    const checks = planInterveneChecks({
      ...base,
      delivered: true,
      events: [toolUse, turnEnd("success"), input(false), turnEnd("success")],
    });
    expect(checks.find((c) => c.name.startsWith("deliver ha rifiutato"))!.passed).toBe(false);
    expect(checks.find((c) => c.name.startsWith("nessun evento input"))!.passed).toBe(false);
    expect(checks.find((c) => c.name.startsWith("un solo result"))!.passed).toBe(false);
  });

  it("deliver mai chiamato (nessun result osservato): rosso, non un verde a vuoto", () => {
    const checks = planInterveneChecks({ ...base, delivered: null, events: [toolUse] });
    expect(checks.find((c) => c.name.startsWith("deliver ha rifiutato"))!.passed).toBe(false);
  });
});

describe("stopPauseChecks", () => {
  const STOP_ID = "22222222-2222-4222-8222-222222222222";
  const MSG_ID = "33333333-3333-4333-8333-333333333333";
  const msg = { type: "input", data: { inputId: MSG_ID, interrupt: false } };
  const resume = {
    mode: "pause-resume" as const,
    stopId: STOP_ID,
    messageId: MSG_ID,
    stopDelivered: true,
    messageDelivered: true,
    exitCode: 0,
    timedOut: false,
    errorName: null,
    source: "export function add(a, b) { return a + b; }",
    events: [toolUse, turnEnd("error_during_execution"), msg, turnEnd("success")],
  };

  it("pause-resume passa: interruzione, messaggio preso dopo, success, add", () => {
    expect(stopPauseChecks(resume).filter((c) => !c.passed)).toEqual([]);
  });

  it("pause-resume: il messaggio prima dell'interruzione (la pausa non c'è stata) è rosso", () => {
    const checks = stopPauseChecks({ ...resume, events: [toolUse, msg, turnEnd("error_during_execution"), turnEnd("success")] });
    expect(checks.find((c) => c.name.startsWith("il processo è rimasto vivo"))!.passed).toBe(false);
  });

  it("un evento input dello «Ferma» è rosso", () => {
    const stopEvent = { type: "input", data: { inputId: STOP_ID, interrupt: true } };
    const checks = stopPauseChecks({ ...resume, events: [stopEvent, ...resume.events] });
    expect(checks.find((c) => c.name.startsWith("lo «Ferma» non produce"))!.passed).toBe(false);
  });

  it("pause-expire passa solo con AgentRunCancelledError, non con un timeout", () => {
    const expire = {
      ...resume,
      mode: "pause-expire" as const,
      messageId: null,
      messageDelivered: null,
      exitCode: -1,
      errorName: "AgentRunCancelledError",
      source: "",
      events: [toolUse, turnEnd("error_during_execution")],
    };
    expect(stopPauseChecks(expire).filter((c) => !c.passed)).toEqual([]);
    const timeout = stopPauseChecks({ ...expire, errorName: "AgentTimeoutError", timedOut: true });
    expect(timeout.find((c) => c.name.startsWith("pausa scaduta"))!.passed).toBe(false);
  });
});

