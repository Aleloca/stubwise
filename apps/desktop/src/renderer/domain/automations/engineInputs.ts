import type { ReasonCode } from "../../data/types";
import { checkClaudeResult } from "./claudeStep";
import {
  PROJECT_NOT_FOUND,
  type ClaudeStep,
  type EngineInput,
  type EngineState,
  type WaitStep,
} from "./engine";
import { EFFECT_KIND, fail, proceedAction, reached, row, type Ctx } from "./engineLoop";
import { AUTOMATION_LIMITS, joinPath, stepAt } from "./fields";
import type { ActionStep } from "./preview";

// Gli input del motore (vedi `engine.ts`): cosa fa ognuno, nello stato in cui
// arriva. Un input che lo stato non aspetta è ignorato.

const currentStep = (st: EngineState) =>
  st.cursor === null ? null : stepAt(st.flow.steps, st.cursor);

function finishWait(
  c: Ctx,
  step: WaitStep,
  path: string,
  output: Record<string, unknown>,
  reason: string | null,
) {
  const st = c.st;
  Object.assign(
    st.vars,
    Object.fromEntries(Object.entries(output).filter(([k]) => k.startsWith("risposta."))),
  );
  c.log.push(
    row({
      stepId: step.id,
      path,
      kind: "wait",
      outcome: "ok",
      input: { ...step.for },
      output,
      reason,
    }),
  );
  st.status = "running";
  st.awaiting = null;
  st.waitingUntil = null;
}

export function handle(c: Ctx, input: EngineInput) {
  const st = c.st;
  const aw = st.awaiting;
  switch (input.kind) {
    case "start": {
      if (st.started) return;
      st.started = true;
      st.event = input.event;
      c.log.push(
        row({
          stepId: "trigger",
          path: "trigger",
          kind: "trigger",
          outcome: "ok",
          output: input.event,
        }),
      );
      st.stack = [{ t: "list", base: "", i: 0 }];
      return;
    }
    case "approved": {
      if (st.status !== "waiting_approval" || aw?.kind !== "approval" || input.path !== aw.path)
        return;
      const step = currentStep(st) as ActionStep;
      c.log.push(
        row({
          stepId: step.id,
          path: aw.path,
          kind: step.kind,
          outcome: "approved",
          byId: input.byId,
        }),
      );
      st.awaiting = null;
      return proceedAction(c, step, aw.path, { edited: input.edited });
    }
    case "rejected": {
      if (st.status !== "waiting_approval" || aw?.kind !== "approval" || input.path !== aw.path)
        return;
      const step = currentStep(st)!;
      c.log.push(
        row({
          stepId: step.id,
          path: aw.path,
          kind: step.kind,
          outcome: "rejected",
          byId: input.byId,
          input: structuredClone(aw.preview),
        }),
      );
      st.status = "cancelled";
      st.error = "rejected";
      st.awaiting = null;
      return;
    }
    case "event": {
      if (st.status !== "waiting_event" || aw?.kind !== "wait") return;
      const step = currentStep(st) as WaitStep;
      const w = step.for;
      const p = input.payload;
      if (p.kind === "reply" && "replyTo" in w && p.to === w.replyTo) {
        return finishWait(
          c,
          step,
          aw.path,
          { "risposta.arrivata": true, "risposta.testo": p.text },
          null,
        );
      }
      if (p.kind === "task_closed" && "taskClosed" in w && p.taskStepId === w.taskClosed) {
        return finishWait(c, step, aw.path, { chiusa: true }, null);
      }
      return;
    }
    case "time": {
      if (Date.parse(input.now) > Date.parse(st.now)) st.now = input.now;
      if (st.status !== "waiting_event" || aw?.kind !== "wait" || !reached(st.now, aw.until))
        return;
      const step = currentStep(st) as WaitStep;
      const w = step.for;
      if ("days" in w) return finishWait(c, step, aw.path, {}, null);
      const reason = `Nessuna risposta entro ${w.maxDays} giorni.`;
      // R-J2: scaduta l'attesa la risposta è assente, mai quella di prima.
      if ("replyTo" in w)
        return finishWait(
          c,
          step,
          aw.path,
          { "risposta.arrivata": false, "risposta.testo": "" },
          reason,
        );
      return finishWait(
        c,
        step,
        aw.path,
        { chiusa: false },
        `La task non è stata chiusa entro ${w.maxDays} giorni.`,
      );
    }
    case "project_chosen": {
      if (aw?.kind !== "project") return;
      const step = currentStep(st) as ActionStep;
      st.projects[aw.clientKey] = input.projectId;
      if (aw.asked) {
        c.log.push(
          row({
            stepId: step.id,
            path: aw.path,
            kind: step.kind,
            outcome: "approved",
            byId: input.byId ?? null,
            input: { clientKey: aw.clientKey },
            output: { progetto: input.projectId },
            reason: "Progetto scelto a mano.",
          }),
        );
      }
      st.status = "running";
      st.awaiting = null;
      return proceedAction(c, step, aw.path, null);
    }
    case "effect_result": {
      if (aw?.kind === "project" && !aw.asked && !input.ok && input.error === PROJECT_NOT_FOUND) {
        const step = currentStep(st)!;
        aw.asked = true;
        st.status = "waiting_project";
        c.log.push(
          row({
            stepId: step.id,
            path: aw.path,
            kind: step.kind,
            outcome: "waiting",
            input: { clientKey: aw.clientKey },
            reason:
              input.reason ??
              "Il cliente non è nella tabella cliente → progetto: deve scegliere il proprietario.",
          }),
        );
        return;
      }
      if (aw?.kind !== "effect") return;
      const step = currentStep(st) as ActionStep;
      st.awaiting = null;
      if (!input.ok) {
        c.log.push(
          row({
            stepId: step.id,
            path: aw.path,
            kind: step.kind,
            outcome: "failed",
            input: structuredClone(aw.preview),
            reason: input.reason ?? input.error ?? null,
            why: input.why ?? null,
          }),
        );
        return fail(c, input.error ?? "effect_failed");
      }
      const codes = input.codes ?? [];
      st.created[step.id] = codes;
      c.log.push(
        row({
          stepId: step.id,
          path: aw.path,
          kind: step.kind,
          outcome: "ok",
          input: structuredClone(aw.preview),
          output: step.kind === "sendEmail" ? { inviata: true } : {},
          reason: input.reason ?? null,
          effects: codes.map((code) => ({ kind: EFFECT_KIND[step.kind], code })),
        }),
      );
      return;
    }
    case "claude_result": {
      if (aw?.kind !== "claude") return;
      const step = currentStep(st) as ClaudeStep;
      st.awaiting = null;
      const check = checkClaudeResult(step, input);
      const uscita = input.outcome === undefined ? {} : { uscita: input.outcome };
      if (!check.ok) {
        const reason = {
          unknown_outcome: `Claude ha restituito un'uscita non prevista dal passo («${input.outcome ?? "nessuna"}»).`,
          bad_field: "Claude ha restituito campi non previsti dal passo o del tipo sbagliato.",
          too_many: `Claude ha restituito un elenco oltre il limite di ${AUTOMATION_LIMITS.forEachRounds} elementi.`,
        }[check.error];
        const whys: Record<typeof check.error, ReasonCode> = {
          unknown_outcome: { code: "unknownOutcome", params: { outcome: input.outcome ?? "—" } },
          bad_field: { code: "badField" },
          too_many: { code: "tooMany", params: { max: AUTOMATION_LIMITS.forEachRounds } },
        };
        const why = whys[check.error];
        c.log.push(
          row({
            stepId: step.id,
            path: aw.path,
            kind: "claude",
            outcome: "failed",
            input: aw.input,
            output: uscita,
            reason,
            why,
          }),
        );
        return fail(c, check.error);
      }
      const fields = input.fields ?? {};
      Object.assign(st.vars, fields);
      c.log.push(
        row({
          stepId: step.id,
          path: aw.path,
          kind: "claude",
          outcome: "ok",
          input: aw.input,
          output: { ...uscita, ...fields },
          reason: input.reason,
        }),
      );
      if (input.outcome !== undefined)
        st.stack.push({ t: "list", base: joinPath(aw.path, input.outcome), i: 0 });
      return;
    }
  }
}
