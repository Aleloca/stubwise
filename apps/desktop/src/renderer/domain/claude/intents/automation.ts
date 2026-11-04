import type { AutomationFlow, Department, Project } from "../../../data/types";
import { RUN_TITLE, draftFlow, type FlowSpec } from "../../automations/draftFlow";
import { named, summarized, type Answer } from "../answers";
import type { IntentContext, T } from "../context";
import { findProject, normalize, stripCourtesy } from "../parse";
import { byClass } from "./change";

// L'intento «automazione» (area 10b, S1): «quando arriva una richiesta di
// supporto urgente, crea una task e avvisa il reparto» diventa una BOZZA coi
// soli blocchi del motore (`draftFlow`), creata subito (classe A, spenta e
// di nessuno: Claude non accende mai un'automazione) e poi provata su due
// esempi (`trial`, la risolve `freeTurn`). Ciò che manca si chiede con una
// scheda di scelta (progetto, reparto); ciò che il motore non sa fare si
// dice, senza inventare un passo né aggiungere da solo quello più vicino
// ([AU 11], P18). Chi non può creare automazioni legge cosa sarebbe nato e
// a chi chiedere. Puro come gli altri intenti: legge come la persona.

const K = "claude.answers.automation";

// --- il riconoscimento -----------------------------------------------------------

/** La frase comincia col «quando» di un'automazione. */
const WHEN = /^(when|whenever|every time|each time|quando|ogni volta che|ogni volta)\b/;
/**
 * «Crea / costruisci / fai un'automazione» come COMANDO, in testa (dopo una
 * cortesia): «Come si crea un'automazione?» e «Chi può creare…?» sono
 * domande, non richieste (I3 della revisione).
 */
const MAKE =
  /^(create|build|make|set up|add|crea|creare|costruisci|costruire|fai|fare|imposta|impostare|aggiungi)\s+(an?\s+|un'|una\s+|un\s+)?(new\s+|nuova\s+)?(automation|automazione)\b/;
/** L'evento che il motore sa ascoltare da una frase: una richiesta nuova. */
const EVENT = /\b(requests?|richiest[ae])\b/;
/** La richiesta viene dal supporto (non il reparto Support: «avvisa Support» non è un filtro). */
const FROM_SUPPORT =
  /\b(support requests?|requests? from (the )?support|from (the )?support|richiest[ae] (di|del|dal|dell'|dall')\s*(supporto|assistenza)|dal(l')?\s*(supporto|assistenza))\b/g;
const URGENT = /\burgent[ei]?\b/;

/**
 * I passi che il motore sa fare da una richiesta, come si dicono. L'email non
 * c'è: una richiesta non porta l'indirizzo del cliente, e un'email «al
 * cliente» andrebbe a un collega (ruling T5 I2). Si dice a parole.
 */
type Kind = "createTask" | "notify";
const ACTIONS: { kind: Kind; words: RegExp }[] = [
  {
    kind: "createTask",
    words:
      /\b((create|open|add|make)\s+(a|an|one)\s+(new\s+)?task|(crea|creare|apri|aprire|aggiungi|aggiungere)\s+(una\s+|un\s+)?(nuova\s+|nuovo\s+)?task)\b/,
  },
  {
    kind: "notify",
    words: /\b(notify|alert|warn|avvisa|avvisare|avverti|avvertire)\b/,
  },
];

/** Ciò che il motore NON sa fare da una richiesta, e la frase che lo dice. */
type Unsupported = "slack" | "call" | "email";
const UNSUPPORTED: { key: Unsupported; words: RegExp }[] = [
  {
    key: "email",
    words:
      /\b((send|write)\s+(an?\s+)?e-?mail|(manda|mandare|invia|inviare|scrivi|scrivere)\s+(un'|una\s+|un\s+)?e-?mail)\b/,
  },
  { key: "slack", words: /\bslack\b/ },
  {
    key: "call",
    words:
      /\b((call|phone|ring)\s+(the\s+)?(customer|client)|(chiama|chiamare|telefona|telefonare)\s+(il\s+|al\s+|a\s+)?cliente)\b/,
  },
];

interface Parsed {
  explicit: boolean;
  when: boolean;
  event: boolean;
  fromSupport: boolean;
  urgent: boolean;
  /** I passi nell'ordine della frase. */
  actions: Kind[];
  unsupported: Unsupported[];
}

function parse(text: string): Parsed {
  const plain = normalize(text);
  const { command } = stripCourtesy(plain);
  // «Crea un'automazione: quando…» comincia col «quando» dopo i due punti.
  const tail = command.replace(/^[^:]*\b(automation|automazione)\b[^:]*:\s*/, "");
  const actions = ACTIONS.map((a) => ({ kind: a.kind, at: plain.search(a.words) }))
    .filter((a) => a.at >= 0)
    .sort((x, y) => x.at - y.at)
    .map((a) => a.kind);
  return {
    explicit: MAKE.test(command),
    when: WHEN.test(command) || WHEN.test(tail),
    event: EVENT.test(plain),
    fromSupport: new RegExp(FROM_SUPPORT.source).test(plain),
    urgent: URGENT.test(plain),
    actions,
    unsupported: UNSUPPORTED.filter((u) => u.words.test(plain)).map((u) => u.key),
  };
}

/**
 * Una frase che descrive un'automazione: comincia col «quando» e dice un
 * evento e qualcosa da fare (anche qualcosa che il motore non sa fare: lo si
 * dice), o chiede esplicitamente di crearne una.
 */
export function isAutomationRequest(text: string): boolean {
  const p = parse(text);
  return p.explicit || (p.when && p.event && (p.actions.length > 0 || p.unsupported.length > 0));
}

// --- le parti della risposta ----------------------------------------------------------

/** L'evento in una parola chiave: urgente e/o dal supporto. */
function eventKey(p: Parsed): "urgentSupport" | "urgent" | "support" | "any" {
  if (p.urgent && p.fromSupport) return "urgentSupport";
  if (p.urgent) return "urgent";
  if (p.fromSupport) return "support";
  return "any";
}

/**
 * Il reparto nominato nella frase («avvisa il reparto Support»), non la
 * richiesta «di supporto». Vince quello nominato per ULTIMO: la risposta a
 * una scheda si accoda alla richiesta («… Marketing» + «Support») e prevale
 * sul reparto che la scheda ha scartato (I1 della revisione).
 */
function namedDepartment(text: string, departments: Department[]): Department | null {
  const rest = normalize(text).replace(FROM_SUPPORT, " ");
  let last: { department: Department; at: number } | null = null;
  for (const department of departments) {
    const name = normalize(department.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const m of rest.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
      if (!last || m.index > last.at) last = { department, at: m.index };
    }
  }
  return last?.department ?? null;
}

/** Il reparto del supporto, per consigliarlo quando l'evento viene da lì (i nomi sono dati configurabili). */
const isSupportDepartment = (d: Department) =>
  /^(support|supporto|assistenza|customer)\b/.test(normalize(d.name));

const DUE_IN_DAYS = 1;

function specOf(p: Parsed, departmentId: string): FlowSpec {
  return {
    event: "request_created",
    when: {
      ...(p.fromSupport ? { fromSupport: true } : {}),
      ...(p.urgent ? { urgency: "high" as const } : {}),
    },
    steps: p.actions.map((kind) =>
      kind === "createTask"
        ? { kind, departmentId, dueInDays: DUE_IN_DAYS }
        : { kind, departmentId },
    ),
  };
}

/** La riga che riassume il flusso, al presente: «Starts when … · creates … · runs on its own.» */
function flowLine(t: T, p: Parsed, code: string, department: string): string {
  const parts = [t(`${K}.start.${eventKey(p)}`, { code })];
  for (const kind of p.actions) {
    parts.push(
      kind === "createTask"
        ? t(`${K}.step.createTask`, { department, count: DUE_IN_DAYS })
        : t(`${K}.step.${kind}`, { department }),
    );
  }
  parts.push(t(`${K}.auto`));
  return `${parts.join(" · ")}.`;
}

/** Le righe di chi non può crearla: cosa farebbe, al condizionale, senza codici d'oggetto. */
function wouldLines(t: T, p: Parsed, code: string, department: string): string[] {
  const lines = [t(`${K}.would.start.${eventKey(p)}`, { code })];
  for (const kind of p.actions) {
    lines.push(
      kind === "createTask"
        ? t(`${K}.would.createTask`, { department, count: DUE_IN_DAYS })
        : t(`${K}.would.notify`, { department, code }),
    );
  }
  return lines.map((l) => `- ${l}`);
}

/** Il nome della bozza da un modello «evento → azione» ([AU 3]). */
function nameOf(t: T, p: Parsed, department: string): string {
  const event = t(`${K}.name.${eventKey(p)}`);
  return t(`${K}.name.${p.actions[0]!}`, { event, department });
}

/** «Automations can't post to Slack.» per ogni cosa che il motore non sa fare. */
const cantLines = (t: T, p: Parsed) => p.unsupported.map((key) => t(`${K}.cant.${key}`));

const say = (text: string): Answer => ({ actions: [], text });

const firstLower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

// --- l'intento ---------------------------------------------------------------------------

export async function automation(text: string, ctx: IntentContext): Promise<Answer> {
  const { read, t } = ctx;
  const p = parse(text);
  if (!p.event) return say(t(`${K}.noEvent`));
  if (p.actions.length === 0) return say([...cantLines(t, p), t(`${K}.noAction`)].join(" "));

  // Il progetto: nominato, o quello del contesto; altrimenti una scheda coi
  // progetti dove chi chiede gestisce le automazioni.
  const projects = await read.listProjects();
  const { project, named: wanted } = findProject(text, projects, ctx.contextProjectId);
  if (wanted && !project) return say(t("claude.answers.status.projectNotFound", { code: wanted }));
  if (!project) return chooseProject(ctx, projects);

  const departments = await read.listDepartments();
  const supportDepartment = departments.find(isSupportDepartment) ?? null;
  const chosen = namedDepartment(text, departments);

  // Senza permesso: cosa sarebbe nato, e a chi chiedere. Nessuna azione.
  if (!(await read.canManageAutomations(project.id))) {
    const department =
      chosen?.name ??
      (p.fromSupport ? supportDepartment?.name : undefined) ??
      t(`${K}.aDepartment`);
    return {
      actions: [],
      text: [
        wouldLines(t, p, project.code, department).join("\n"),
        `${t(`${K}.cantCreate`, { code: project.code })} ·`,
      ].join("\n\n"),
      place: {
        route: `who:manageProjectAutomations/${project.code}`,
        labelKey: "claude.answers.refused.who",
      },
    };
  }

  // Il reparto: nominato, o una scheda (Support consigliato se l'evento viene dal supporto).
  // Ogni passo che il motore sa fare da una richiesta va a un reparto.
  if (!chosen) {
    if (!ctx.asks) return say(t(`${K}.stillNeed.department`));
    const recommended = p.fromSupport ? supportDepartment : null;
    const ordered = recommended
      ? [recommended, ...departments.filter((d) => d.id !== recommended.id)]
      : departments;
    const which = p.actions.includes("createTask")
      ? p.actions.includes("notify")
        ? "department"
        : "departmentTask"
      : "departmentNotify";
    return {
      actions: [],
      text: "",
      ask: {
        text: t(`${K}.ask.${which}`),
        options: ordered.map((d) =>
          d.id === recommended?.id ? { label: d.name, recommended: true } : { label: d.name },
        ),
      },
    };
  }

  const department = chosen;
  const flow = draftFlow(specOf(p, department.id), t);
  let issues = await read.validateAutomationFlow(flow, project.id);
  // L'unica cosa che Claude corregge da sé: il titolo delle esecuzioni, se manca.
  if (flow.titleTemplate.trim() === "") {
    flow.titleTemplate = RUN_TITLE;
    issues = await read.validateAutomationFlow(flow, project.id);
  }
  if (issues.some((i) => i.code === "department_cant_see")) {
    return departmentCantSee(ctx, p, project, department, departments);
  }
  if (issues.length > 0) {
    // Ogni altro problema si dice, e non nasce niente.
    const issue = firstLower(t(`automations.issue.${issues[0]!.code}`));
    return say(t(`${K}.invalid`, { issue }));
  }

  const lines = [flowLine(t, p, project.code, department.name)];
  if (p.unsupported.length > 0) lines.push([...cantLines(t, p), t(`${K}.closest`)].join(" "));
  // Nella Chat la prova non c'è (P11): una riga che rimanda al riquadro.
  if (!ctx.classify) lines.push(t(`${K}.panel`));
  const said = lines.join("\n\n");
  const name = nameOf(t, p, department.name);
  const result = await byClass(
    ctx,
    {
      fn: "createAutomation",
      args: { projectId: project.id, name, flow },
      ...summarized(t, `${K}.summary`, { name, code: project.code }),
    },
    said,
    said,
  );
  return {
    actions: [],
    refs: [{ kind: "project", id: project.id }],
    ...result,
    ...(result.execute ? { trial: { wants: ["passes", "fails"] } } : {}),
  };
}

/** La scheda dei progetti dove chi chiede gestisce le automazioni (i fissati per primi). */
async function chooseProject(ctx: IntentContext, projects: Project[]): Promise<Answer> {
  const { read, t } = ctx;
  const allowed = await Promise.all(projects.map((p) => read.canManageAutomations(p.id)));
  const pinned = new Set(await read.listPinnedProjectIds());
  const manageable = projects
    .filter((_, i) => allowed[i])
    .sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));
  if (manageable.length === 0) return say(t(`${K}.cantAny`));
  if (!ctx.asks) return say(t(`${K}.stillNeed.project`));
  return {
    actions: [],
    text: "",
    ask: {
      text: t(`${K}.ask.project`),
      options: manageable.map((p) => ({ label: named({ code: p.code, title: p.name }) })),
    },
  };
}

/**
 * Nessuno del reparto vede il progetto: una scheda coi soli reparti in cui
 * qualcuno lo vede (nessuno consigliato), o la riga quando le schede sono
 * finite.
 */
async function departmentCantSee(
  ctx: IntentContext,
  p: Parsed,
  project: Project,
  department: Department,
  departments: Department[],
): Promise<Answer> {
  const { read, t } = ctx;
  const params = { department: department.name, code: project.code };
  if (!ctx.asks) return say(t(`${K}.stillNeed.departmentCantSee`, params));
  const sees = await Promise.all(
    departments.map(async (d) => {
      const flow: AutomationFlow = draftFlow(specOf(p, d.id), t);
      const issues = await read.validateAutomationFlow(flow, project.id);
      return !issues.some((i) => i.code === "department_cant_see");
    }),
  );
  const options = departments.filter((_, i) => sees[i]).map((d) => ({ label: d.name }));
  if (options.length === 0) return say(t(`${K}.stillNeed.departmentCantSee`, params));
  return {
    actions: [],
    text: "",
    ask: { text: t(`${K}.ask.departmentCantSee`, params), options },
  };
}
