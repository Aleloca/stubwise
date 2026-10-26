import type { Approval, ProjectTarget, Step } from "../../data/types";
import { lookup } from "./conditions";
import type { EngineState, ResolvedTarget } from "./engine";

// I dati e i testi del motore: come si legge una chiave in un punto
// dell'esecuzione, come si compila un modello, cosa vede chi approva e cosa
// riceve l'esecutore. Puro, come il motore.

export type ActionStep = Extract<Step, { approval: Approval }>;
export type ApprovalWho = Extract<Approval, { mode: "ask" }>["who"];

/** Il valore di una chiave: la variabile di un `forEach` (dal più interno), le variabili, l'evento. */
export function resolve(st: EngineState, key: string): unknown {
  for (let k = st.stack.length - 1; k >= 0; k--) {
    const f = st.stack[k]!;
    if (f.t !== "forEach" || f.current < 0) continue;
    const item = f.items[f.current];
    if (key === f.as) return item;
    if (key.startsWith(`${f.as}.`)) {
      return item !== null && typeof item === "object"
        ? lookup(item as Record<string, unknown>, key.slice(f.as.length + 1))
        : undefined;
    }
  }
  if (Object.prototype.hasOwnProperty.call(st.vars, key)) return st.vars[key];
  return lookup(st.event, key);
}

/** Un valore come testo: elenchi separati da virgole, oggetti col loro nome. */
export function show(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(show).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return show(o.nome ?? o.titolo ?? o.name ?? "");
  }
  return String(v);
}

export const render = (st: EngineState, text: string) =>
  text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key: string) => show(resolve(st, key)));

export const projectOf = (step: Step): ProjectTarget | null =>
  step.kind === "createTask" || step.kind === "createMilestone" || step.kind === "createRequest"
    ? step.project
    : null;

/** L'anteprima (cosa vede chi approva, l'input della riga) e gli argomenti dell'effetto. */
export function describe(
  st: EngineState,
  step: ActionStep,
  target: ResolvedTarget | null,
  edited: Record<string, string> = {},
): { preview: Record<string, unknown>; args: Record<string, unknown> } {
  const progetto = target?.mode === "fixed" ? { progetto: target.projectId } : {};
  const pick = (key: string, value: string) => edited[key] ?? value;
  switch (step.kind) {
    case "createTask": {
      const titolo = pick("titolo", render(st, step.title));
      const descrizione = pick("descrizione", render(st, step.description));
      const ms = step.milestoneRef ? (st.created[step.milestoneRef]?.at(-1) ?? null) : null;
      return {
        preview: { titolo, descrizione, ...progetto },
        args: {
          title: titolo,
          description: descrizione,
          assignee: step.assignee,
          dueInDays: step.dueInDays,
          milestoneCode: ms,
        },
      };
    }
    case "createMilestone": {
      const nome = pick("nome", render(st, step.name));
      return { preview: { nome, ...progetto }, args: { name: nome, dueInDays: step.dueInDays } };
    }
    case "createRequest": {
      const titolo = pick("titolo", render(st, step.title));
      const descrizione = pick("descrizione", render(st, step.description));
      return {
        preview: { titolo, descrizione, ...progetto },
        args: { title: titolo, description: descrizione },
      };
    }
    case "sendEmail": {
      const to = pick("to", render(st, step.to));
      const subject = pick("subject", render(st, step.subject));
      const body = pick("body", render(st, step.body));
      const attachments = step.attachRefs.map((r) => resolve(st, r));
      return {
        preview: {
          to,
          subject,
          body,
          ...(attachments.length ? { allegati: attachments.map(show) } : {}),
        },
        args: { to, subject, body, attachments },
      };
    }
    case "notify": {
      // Un modello si compila e il risultato È l'id; un campo si legge una
      // volta sola. Mai un secondo giro: il valore non diventa una chiave.
      const personId = step.personRef.includes("{{")
        ? render(st, step.personRef)
        : show(resolve(st, step.personRef));
      const testo = pick("testo", render(st, step.text));
      return { preview: { persona: personId, testo }, args: { personId, text: testo } };
    }
    case "startAutomation":
      return {
        preview: { automazione: step.automationId },
        args: { automationId: step.automationId },
      };
  }
}

/** La motivazione della riga «in attesa di approvazione». */
export const approverReason = (who: ApprovalWho): string =>
  "owner" in who
    ? "Chiede l'approvazione del proprietario."
    : "personId" in who
      ? "Chiede l'approvazione della persona indicata."
      : `Chiede l'approvazione del ruolo «${who.projectRole}» nel progetto.`;
