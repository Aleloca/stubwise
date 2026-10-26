import {
  PROJECT_NOT_FOUND,
  type EffectRequest,
  type EngineInput,
} from "../../domain/automations/engine";
import { AUTOMATION_LIMITS } from "../../domain/automations/fields";
import { show } from "../../domain/automations/preview";
import { fold } from "../../domain/textSearch";
import { createMilestoneAs, createRequestAs, createTaskAs } from "../api-mutations";
import { EMAIL, lower } from "../mail/compose";
import { canSeeMessage } from "../mail/visibility";
import { sendNow } from "../mail/send";
import { PEOPLE } from "../seed/people";
import { newId, state, visibleProjectIds } from "../store";
import type { Automation, AutomationRun, Step } from "../types";
import { canSeeAutomation, holdersOfRole, runCode } from "./visibility";

// L'UNICO esecutore degli effetti delle automazioni (area 7). Il motore
// chiede (`EffectRequest`), questo modulo fa — con le scritture di oggi, a
// nome del PROPRIETARIO dell'automazione e coi suoi permessi — e risponde
// con l'input che rientra nel motore. Nessun altro punto del prototipo crea
// task, traguardi, richieste, email o notifiche per un'automazione.
//
// - Permesso perso (il proprietario non vede più il progetto, o non ha il
//   permesso di creare) → `permission_lost`, mai un'azione a nome di altri.
// - Le email partono SOLO da una casella del proprietario (`sendNow` della
//   Posta, area 6): senza casella `mailbox_missing`, account scaduto
//   `mailbox_expired`. Il limite di 20 email vale per la catena intera
//   degli avvii (`startAutomation`).
// - Il progetto «del cliente» si trova nella tabella cliente → progetto;
//   uno che il proprietario non vede vale come non trovato (R-G5): l'attesa
//   «scegli il progetto».
// - Ogni task e traguardo creato porta `automationRef`.
// Gli errori sono codici macchina; la prosa sta solo nel `reason` della riga.

type ClaudeStep = Extract<Step, { kind: "claude" }>;

export interface EffectEnv {
  run: AutomationRun;
  automation: Automation;
  /** L'«adesso» dell'esecuzione (ISO). */
  now: string;
  /** Avvia l'esecuzione figlia di `startAutomation` (la crea il runner). */
  spawn(target: Automation, event: Record<string, unknown>): AutomationRun | null;
}

export interface EffectOutcome {
  input: EngineInput;
  /** Il progetto in cui l'effetto ha agito (entra in `projectIds` dell'esecuzione). */
  projectId?: string;
}

/** L'esecuzione che sta eseguendo un effetto adesso: i segnali che produce sono suoi (catene). */
let origin: string | null = null;
export const currentOrigin = (): string | null => origin;

const personName = (id: string | null) => PEOPLE.find((p) => p.id === id)?.name ?? id ?? "—";

const failed = (error: string, reason: string): EffectOutcome => ({
  input: { kind: "effect_result", ok: false, error, reason },
});

const done = (codes: string[], projectId?: string, reason?: string): EffectOutcome => ({
  input: { kind: "effect_result", ok: true, codes, ...(reason ? { reason } : {}) },
  ...(projectId ? { projectId } : {}),
});

const DAY = 86_400_000;
const dateIn = (now: string, days: number | null): string | null =>
  days === null ? null : new Date(Date.parse(now) + days * DAY).toISOString().slice(0, 10);

/** Un errore di una scrittura di oggi, come codice dell'esecuzione. */
function asFailure(error: unknown, owner: string): EffectOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "forbidden" || message === "not_found") {
    return failed(
      "permission_lost",
      `Permesso perso: il proprietario (${personName(owner)}) non può più farlo in questo progetto.`,
    );
  }
  return failed("invalid_input", `Dati non validi per il passo (${message}).`);
}

/** Il progetto di un'azione, risolto dal motore. */
function projectOfEffect(eff: Extract<EffectRequest, { args: unknown }>, a: Automation) {
  const t = eff.projectTarget;
  if (!t) return null;
  return t.mode === "own" ? a.projectId : t.projectId;
}

/** Le esecuzioni della stessa catena di avvii (dalla radice). */
export function chainOf(run: AutomationRun): AutomationRun[] {
  let root = run;
  while (root.parentRunId) {
    const parent = state.automationRuns.find((r) => r.id === root.parentRunId);
    if (!parent) break;
    root = parent;
  }
  const out: AutomationRun[] = [];
  const visit = (r: AutomationRun) => {
    out.push(r);
    for (const child of state.automationRuns.filter((c) => c.parentRunId === r.id)) visit(child);
  };
  visit(root);
  return out;
}

/** Le automazioni sopra un'esecuzione nella catena, la sua compresa. */
export function ancestorsOf(run: AutomationRun): AutomationRun[] {
  const out = [run];
  let cur = run;
  while (cur.parentRunId) {
    const parent = state.automationRuns.find((r) => r.id === cur.parentRunId);
    if (!parent) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

/** La profondità massima di una catena di avvii. */
export const CHAIN_MAX = 3;

const emailsSent = (runs: AutomationRun[]) =>
  runs.reduce(
    (n, r) => n + r.log.filter((e) => e.kind === "sendEmail" && e.outcome === "ok").length,
    0,
  );

// --- le azioni ----------------------------------------------------------------------

function createTask(eff: Extract<EffectRequest, { args: unknown }>, env: EffectEnv, owner: string) {
  const { automation: a, run } = env;
  const projectId = projectOfEffect(eff, a);
  if (!projectId || !visibleProjectIds(owner).has(projectId)) return lost(owner);
  const args = eff.args as {
    title: string;
    description: string;
    assignee: { personId: string } | { departmentId: string } | { projectRole: string } | null;
    dueInDays: number | null;
    milestoneCode: string | null;
  };
  let assigneeId: string | null = null;
  let departmentId: string | undefined;
  let reason: string | undefined;
  const who = args.assignee;
  if (who && "personId" in who) {
    assigneeId = who.personId;
    departmentId = PEOPLE.find((p) => p.id === who.personId)?.departmentIds[0];
  } else if (who && "departmentId" in who) {
    departmentId = who.departmentId;
  } else if (who && "projectRole" in who) {
    assigneeId = holdersOfRole(projectId, who.projectRole)[0] ?? null;
    if (assigneeId) departmentId = PEOPLE.find((p) => p.id === assigneeId)?.departmentIds[0];
    else
      reason = `Nessuno ha il ruolo «${who.projectRole}» nel progetto: la task nasce senza incaricato.`;
  }
  const milestone = state.milestones.find(
    (m) => m.id === args.milestoneCode && m.projectId === projectId,
  );
  const task = createTaskAs(owner, {
    projectId,
    title: args.title,
    description: args.description,
    assigneeId,
    ...(departmentId ? { departmentId } : {}),
    dueDate: dateIn(env.now, args.dueInDays),
    milestoneId: milestone?.id ?? null,
  });
  task.source = "automation";
  task.automationRef = { automationId: a.id, runId: run.id };
  return done([task.code], projectId, reason);
}

const lost = (owner: string) =>
  failed(
    "permission_lost",
    `Permesso perso: il proprietario (${personName(owner)}) non vede più il progetto del passo.`,
  );

function createMilestone(
  eff: Extract<EffectRequest, { args: unknown }>,
  env: EffectEnv,
  owner: string,
) {
  const projectId = projectOfEffect(eff, env.automation);
  if (!projectId || !visibleProjectIds(owner).has(projectId)) return lost(owner);
  const args = eff.args as { name: string; dueInDays: number | null };
  const milestone = createMilestoneAs(owner, projectId, {
    name: args.name,
    dueDate: dateIn(env.now, args.dueInDays),
  });
  milestone.automationRef = { automationId: env.automation.id, runId: env.run.id };
  return done([milestone.id], projectId);
}

function createRequest(
  eff: Extract<EffectRequest, { args: unknown }>,
  env: EffectEnv,
  owner: string,
) {
  const projectId = projectOfEffect(eff, env.automation);
  if (!projectId || !visibleProjectIds(owner).has(projectId)) return lost(owner);
  const args = eff.args as { title: string; description: string };
  const request = createRequestAs(owner, {
    projectId,
    title: args.title,
    description: args.description,
  });
  return done([request.code], projectId);
}

function sendEmail(eff: Extract<EffectRequest, { args: unknown }>, env: EffectEnv, owner: string) {
  const args = eff.args as { to: string; subject: string; body: string; attachments: unknown[] };
  if (emailsSent(chainOf(env.run)) >= AUTOMATION_LIMITS.emailsPerRun) {
    return failed(
      "email_limit",
      `Limite raggiunto: al massimo ${AUTOMATION_LIMITS.emailsPerRun} email per esecuzione, contando le automazioni avviate da questa.`,
    );
  }
  if (!state.mailboxes.some((b) => b.personId === owner)) {
    return failed(
      "mailbox_missing",
      `Il proprietario (${personName(owner)}) non ha una casella collegata: l'email non è partita.`,
    );
  }
  if (state.googleAccounts.find((g) => g.personId === owner)?.status !== "connected") {
    return failed(
      "mailbox_expired",
      `La casella del proprietario (${personName(owner)}) è scaduta: va ricollegata prima di riprovare.`,
    );
  }
  const to = args.to.trim();
  if (!EMAIL.test(to)) return failed("invalid_address", `«${to}» non è un indirizzo email.`);
  const message = sendNow(owner, {
    ...threadFor(env.run, owner, to),
    to: [{ name: "", email: to, personId: null }],
    cc: [],
    subject: args.subject,
    body: args.body,
    attachments: args.attachments.map((f, i) => ({
      id: `att-${env.run.id}-${eff.stepId}-${i}`,
      name: show(f) || `Allegato ${i + 1}`,
      sizeBytes: show((f as { testo?: unknown } | null)?.testo).length,
      driveFileId: null,
      as: "copy" as const,
    })),
  });
  if (message.delivery?.state !== "sent") {
    return failed(
      "address_not_found",
      `L'indirizzo «${to}» non esiste: l'email è tornata indietro.`,
    );
  }
  return done([message.id]);
}

/**
 * Le email di un'esecuzione allo stesso indirizzo stanno in UNA
 * conversazione (il promemoria risponde alla richiesta): la risposta del
 * cliente vi arriva comunque risponda, e sblocca l'attesa del passo che la
 * aspetta. Una conversazione che il proprietario non vede (è cambiato) ne
 * apre una nuova.
 */
function threadFor(run: AutomationRun, owner: string, to: string) {
  const sent = run.log
    .filter((e) => e.kind === "sendEmail" && e.outcome === "ok")
    .flatMap((e) => e.effects.map((x) => x.code));
  const prior = sent
    .map((id) => state.mailMessages.find((m) => m.id === id))
    .filter(
      (m) =>
        m?.delivery?.state === "sent" &&
        m.from.personId === owner &&
        m.to.some((a) => lower(a.email) === lower(to)),
    )
    .at(-1);
  const last = prior
    ? state.mailMessages
        .filter((m) => m.threadId === prior.threadId && canSeeMessage(owner, m))
        .sort((a, b) => a.at.localeCompare(b.at))
        .at(-1)
    : undefined;
  return last
    ? { threadId: last.threadId, mode: "reply" as const, replyToMessageId: last.id, quote: false }
    : { threadId: null, mode: "new" as const, replyToMessageId: null };
}

function notify(eff: Extract<EffectRequest, { args: unknown }>, env: EffectEnv) {
  const args = eff.args as { personId: string; text: string };
  const person = PEOPLE.find((p) => p.id === args.personId && !p.isClaude);
  if (!args.personId || !person) {
    return failed("no_recipient", "Non c'è nessuno da avvisare: il dato della persona è vuoto.");
  }
  const projectId = env.automation.projectId ?? env.run.projectIds[0] ?? null;
  if (projectId && !visibleProjectIds(person.id).has(projectId)) {
    return failed("recipient_cant_see", `${person.name} non vede il progetto: l'avviso non parte.`);
  }
  const code = runCode(env.run);
  const notification = {
    id: newId("n"),
    kind: "automation.notify",
    projectId,
    objectCode: code,
    departmentId: null,
    recipientIds: [person.id],
    title: `${env.automation.name} · ${code}`,
    body: args.text,
    createdAt: env.now,
    read: false,
    archived: false,
    snoozedUntil: null,
    link: `#/automations?run=${env.run.id}`,
  };
  state.notifications.push(notification);
  return done([notification.id]);
}

function startAutomation(
  eff: Extract<EffectRequest, { args: unknown }>,
  env: EffectEnv,
  owner: string,
) {
  const id = (eff.args as { automationId: string }).automationId;
  const target = state.automations.find((a) => a.id === id);
  if (!target || !canSeeAutomation(owner, target)) {
    return failed(
      "automation_not_found",
      "L'automazione da avviare non esiste o il proprietario non la vede.",
    );
  }
  if (target.status !== "active") {
    return failed("automation_not_active", `«${target.name}» non è attiva: non è partita.`);
  }
  const chain = ancestorsOf(env.run);
  if (chain.some((r) => r.automationId === target.id)) {
    return failed(
      "automation_cycle",
      `«${target.name}» è già in questa catena di avvii: niente cicli.`,
    );
  }
  if (chain.length >= CHAIN_MAX) {
    return failed(
      "chain_limit",
      `Limite raggiunto: al massimo ${CHAIN_MAX} automazioni in una catena di avvii.`,
    );
  }
  const child = env.spawn(target, env.run.event);
  if (!child) {
    return failed("run_limit", `«${target.name}» ha già troppe esecuzioni in corso.`);
  }
  return done([runCode(child)]);
}

// --- il progetto del cliente ------------------------------------------------------

function resolveProject(
  eff: Extract<EffectRequest, { kind: "resolve_project" }>,
  owner: string,
): EffectOutcome {
  const link = state.clientProjectLinks.find((l) => l.clientKey === eff.clientKey);
  // Un progetto che il proprietario non vede vale come uno che non c'è (R-G5).
  if (
    !link ||
    !state.projectsById.has(link.projectId) ||
    !visibleProjectIds(owner).has(link.projectId)
  )
    return { input: { kind: "effect_result", ok: false, error: PROJECT_NOT_FOUND } };
  return {
    input: { kind: "project_chosen", projectId: link.projectId },
    projectId: link.projectId,
  };
}

// --- Claude (finto) ---------------------------------------------------------------

/** Che cosa fa il reparto per ogni prodotto venduto (il contratto «letto» da Claude). */
const PRODUCT_TASKS: Record<string, [titolo: string, reparto: string][]> = {
  CRM: [
    ["Importare l'anagrafica clienti nel CRM", "Development"],
    ["Pianificare le sessioni di formazione sul CRM", "Sales"],
  ],
  "Centralino AI": [["Configurare il Centralino AI", "Support"]],
  "Campagne WhatsApp": [
    ["Verificare il numero WhatsApp Business", "Support"],
    ["Preparare i modelli dei messaggi", "Sales"],
  ],
  "Preventivi online": [["Caricare il catalogo dal listino", "Development"]],
};

const STOP = new Set([
  "della",
  "delle",
  "degli",
  "dello",
  "alla",
  "alle",
  "agli",
  "con",
  "per",
  "testo",
]);

/** Le cose chieste in un elenco libero («A, B e C»), ognuna con la sua parola chiave. */
function requested(text: string): { item: string; key: string }[] {
  return text
    .replace(/\.$/, "")
    .split(/,|\se\s/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const words = fold(item)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3 && !STOP.has(w));
      // La radice della parola più lunga: «apertura» si ritrova in «aperti».
      const word = words.sort((x, y) => y.length - x.length)[0] ?? fold(item);
      return { item, key: word.slice(0, 5) };
    });
}

/**
 * La risposta finta di Claude, deterministica per istruzione e input: le
 * uscite e i campi dichiarati dal passo, col loro tipo. La verifica col
 * dichiarato la fa comunque il motore (`checkClaudeResult`): qui si finge
 * solo la lettura.
 */
export function fakeClaude(
  step: ClaudeStep,
  input: Record<string, unknown>,
  ownerId: string | null,
): Extract<EngineInput, { kind: "claude_result" }> {
  const values = Object.entries(input);
  const reply = values.find(([k]) => k.startsWith("risposta."))?.[1];
  const askedFor = values.find(
    ([k, v]) => !k.startsWith("risposta.") && typeof v === "string",
  )?.[1];
  const missing =
    typeof askedFor === "string"
      ? requested(askedFor).filter(({ key }) => !fold(show(reply)).includes(key))
      : [];
  const allText = fold(values.map(([, v]) => JSON.stringify(v ?? "")).join(" "));
  const products = values
    .map(([, v]) => v)
    .find((v): v is { nome: string }[] => Array.isArray(v) && v.some((x) => typeof x === "object"));
  const contract = values.map(([, v]) => v).find((v) => show((v as { testo?: unknown })?.testo));

  let outcome: string | undefined;
  if (step.outcomes.length > 0) {
    if (reply !== undefined) {
      outcome = missing.length === 0 ? step.outcomes[0] : step.outcomes.at(-1);
    } else {
      outcome =
        step.outcomes.find((o) => allText.includes(fold(o))) ??
        (/(errore|non funziona|si blocca|crash)/.test(allText) && step.outcomes.includes("bug")
          ? "bug"
          : step.outcomes.at(-1));
    }
  }

  const fields: Record<string, unknown> = {};
  for (const f of step.fields) {
    if (f.type === "list") {
      const hasTasks =
        f.of?.some((x) => x.key === "titolo") && f.of.some((x) => x.key === "reparto");
      const tasks = hasTasks
        ? [
            ...(products ?? []).flatMap((p) =>
              (PRODUCT_TASKS[p.nome] ?? [[`Attivare ${p.nome}`, "Support"]]).map(
                ([titolo, reparto]) => ({ titolo, reparto }),
              ),
            ),
            ...(fold(show((contract as { testo?: unknown })?.testo)).includes("fattur")
              ? [{ titolo: "Fatturare il primo canone all'attivazione", reparto: "Administration" }]
              : []),
          ]
        : [];
      fields[f.key] = tasks.slice(0, AUTOMATION_LIMITS.forEachRounds);
    } else if (f.type === "number") fields[f.key] = 0;
    else if (f.type === "boolean") fields[f.key] = show(reply).trim() !== "";
    else if (f.type === "date") fields[f.key] = new Date(0).toISOString().slice(0, 10);
    else if (f.type === "email")
      fields[f.key] =
        allText.match(/[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]+/)?.[0] ?? "cliente@example.com";
    else if (f.type === "person") fields[f.key] = ownerId ?? "p-roberta";
    else if (/mancant/.test(f.key)) fields[f.key] = missing.map((m) => m.item).join(", ");
    else if (/prodotto/.test(f.key)) fields[f.key] = products?.[0]?.nome ?? "";
    else fields[f.key] = show(values[0]?.[1]).slice(0, 200);
  }

  const reason =
    reply !== undefined
      ? missing.length === 0
        ? "La risposta contiene tutto quello che era stato chiesto."
        : `Nella risposta manca: ${missing.map((m) => m.item).join(", ")}.`
      : products
        ? `Ho letto il contratto e i prodotti venduti (${products.map((p) => p.nome).join(", ")}).`
        : `Ho letto ${values.map(([k]) => `«${k}»`).join(", ") || "l'evento"}.`;
  return { kind: "claude_result", ...(outcome !== undefined ? { outcome } : {}), fields, reason };
}

// --- l'esecutore ------------------------------------------------------------------

/** Esegue un effetto a nome del proprietario e restituisce l'input da rimettere nel motore. */
export function executeEffect(eff: EffectRequest, env: EffectEnv): EffectOutcome {
  const owner = env.automation.ownerId;
  if (eff.kind === "claude") {
    return { input: fakeClaude(eff.step, eff.vars, owner) };
  }
  if (!owner) {
    return failed("permission_lost", "Permesso perso: l'automazione non ha un proprietario.");
  }
  if (eff.kind === "resolve_project") return resolveProject(eff, owner);
  origin = env.run.id;
  try {
    switch (eff.kind) {
      case "createTask":
        return createTask(eff, env, owner);
      case "createMilestone":
        return createMilestone(eff, env, owner);
      case "createRequest":
        return createRequest(eff, env, owner);
      case "sendEmail":
        return sendEmail(eff, env, owner);
      case "notify":
        return notify(eff, env);
      case "startAutomation":
        return startAutomation(eff, env, owner);
    }
  } catch (error) {
    return asFailure(error, owner);
  } finally {
    origin = null;
  }
}
