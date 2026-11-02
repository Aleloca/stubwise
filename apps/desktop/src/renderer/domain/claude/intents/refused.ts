import type { Project, Task } from "../../../data/types";
import { labelled, resulted, type Answer, type ReadAction } from "../answers";
import type { IntentContext } from "../context";
import { QUESTION, findCodes, findProject, normalize, stripCourtesy } from "../parse";

// La classe D (area 10a): ciò che è un gesto delle persone Claude non lo fa
// — approvare un piano, il merge, rispondere alla sua domanda, scrivere nel
// registro decisioni, accendere un'automazione, i segreti, i server, gli
// invii, il deploy. La risposta è una riga di Claude: la frase, poi il link
// al posto vero (`Answer.place`), mai una scheda né un'azione. Qui si
// riconosce e si legge come la persona; nessuna funzione di quei gesti è
// nominata nel codice (`neverInCatalog.test.ts`): le parole stanno nelle
// regex, i posti negli indirizzi.

export type RefusedTopic =
  | "approve_plan"
  | "merge"
  | "answer_question"
  | "record_decision"
  | "activate_automation"
  | "secret"
  | "server"
  | "send";

/** Il deploy ha solo la frase, senza link: Stubwise si ferma al merge. */
type Refusal = RefusedTopic | "deploy";

interface Rule {
  topic: Refusal;
  /** Il verbo all'imperativo in testa (sempre). */
  verb: RegExp;
  /** Il verbo all'infinito (solo dopo una cortesia: «Puoi approvare…»). */
  infinitive: RegExp;
  /** Di cosa deve parlare il comando, se il verbo da solo non basta. */
  about?: RegExp;
  /**
   * `about` solo nelle prime N parole: «crea un token» è un segreto, «crea
   * una task per ruotare la chiave API in MKX» è una task.
   */
  within?: number;
  /** Ciò che lo esclude (un merge di richieste non è il merge di una PR). */
  unless?: RegExp;
}

// In ordine: il primo che riconosce vince. «Rispondi alla domanda» prima di
// «rispondi al cliente», l'automazione prima di «pubblica il rilascio».
const RULES: Rule[] = [
  {
    topic: "deploy",
    verb: /^(deploy|redeploy|deploya|fai (il )?deploy|metti in produzione|porta in produzione|rilascia in produzione)\b/,
    infinitive:
      /^(deployare|fare (il )?deploy|mettere in produzione|portare in produzione|rilasciare in produzione)\b/,
  },
  {
    topic: "approve_plan",
    verb: /^(approve|reject|pre-?approve|approva|approvalo|approvala|rifiuta|boccia|pre-?approva)\b/,
    infinitive: /^(approvare|approvarlo|approvarla|rifiutare|bocciare|pre-?approvare)\b/,
    about: /\b(plan|piano)\b/,
  },
  {
    topic: "activate_automation",
    verb: /^(activate|turn on|switch on|enable|publish|attiva|attivala|accendi|accendila|abilita|pubblica)\b/,
    infinitive: /^(attivare|attivarla|accendere|accenderla|abilitare|pubblicare)\b/,
    about: /\b(automations?|automazion[ei]|[a-z]{2,4}-a\d+|aut-\d+)\b/,
  },
  {
    topic: "merge",
    verb: /^(merge|mergia|mergiala|mergialo|fai (il )?merge)\b/,
    infinitive: /^(mergiare|mergiarla|mergiarlo|fare (il )?merge)\b/,
    unless: /\b[a-z]{2,4}-r\d+\b/,
  },
  {
    topic: "merge",
    verb: /^(publish|pubblica)\b/,
    infinitive: /^(pubblicare)\b/,
    about: /\b(release|rilascio|pull request|pr)\b/,
  },
  {
    topic: "answer_question",
    verb: /^(answer|reply to|respond to|rispondi|rispondigli)\b/,
    infinitive: /^(rispondere|rispondergli)\b/,
    about: /\b(question|domanda)\b/,
  },
  {
    topic: "record_decision",
    verb: /^(record|log|write down|note down|registra|annota|scrivi|segna)\b/,
    infinitive: /^(registrare|annotare|scrivere|segnare)\b/,
    about: /\b(decision|decisione)\b/,
  },
  {
    topic: "secret",
    verb: /^(create|generate|make|show|give|reveal|regenerate|rotate|crea|creami|genera|generami|mostra|mostrami|dammi|rigenera|ruota)\b/,
    infinitive:
      /^(creare|crearmi|generare|generarmi|mostrare|mostrarmi|dare|darmi|rigenerare|ruotare)\b/,
    about:
      /\b(tokens?|api keys?|keys?|secrets?|passwords?|invite links?|invitation links?|link d'invito|link di invito|chiavi|chiave|segret[oi])\b/,
    within: 5,
  },
  {
    topic: "server",
    verb: /^(restart|reboot|shut down|shutdown|stop|start|ssh into|riavvia|spegni|ferma|accendi|avvia)\b/,
    infinitive: /^(riavviare|spegnere|fermare|accendere|avviare)\b/,
    about: /\b(servers?|srv-\d+)\b/,
  },
  {
    topic: "send",
    verb: /^(send|reply|email|invia|inviala|manda|mandala|spedisci|rispondi)\b/,
    infinitive: /^(inviare|mandare|spedire|rispondere)\b/,
    about: /\b(e-?mails?|mail|reply|risposta|drafts?|bozza|customers?|clients?|cliente|clienti)\b/,
  },
];

/** Il tema di una richiesta che Claude non esegue, deploy compreso; `null` se non lo è. */
function refusalOf(text: string): Refusal | null {
  const { polite, command } = stripCourtesy(normalize(text));
  // Una domanda («come si approva un piano?», «chi ha fatto il merge?») si legge e basta.
  if (!polite && QUESTION.test(command)) return null;
  // Un titolo fra virgolette non è un tema: «Crea “Ruotare i token” in MKX» crea.
  const plain = command.replace(/["“«][^"”»]*["”»]/g, " ");
  for (const rule of RULES) {
    const verb = rule.verb.test(plain) || (polite && rule.infinitive.test(plain));
    if (!verb) continue;
    const head = rule.within
      ? plain
          .split(" ")
          .slice(0, rule.within + 1)
          .join(" ")
      : plain;
    if (rule.about && !rule.about.test(head)) continue;
    if (rule.unless?.test(plain)) continue;
    return rule.topic;
  }
  return null;
}

/** Il tema D di un comando (en/it, anche dopo una cortesia); `null` per tutto il resto e per il deploy. */
export function refusedTopicOf(text: string): RefusedTopic | null {
  const topic = refusalOf(text);
  return topic === "deploy" ? null : topic;
}

/** Il comando è una riga D: un tema di `RefusedTopic` o il deploy. */
export function isRefused(text: string): boolean {
  return refusalOf(text) !== null;
}

const KEY = "claude.answers.refused";

/** La riga D: la frase del tema e il link al posto vero, come la persona lo vede. */
export async function refused(text: string, ctx: IntentContext): Promise<Answer> {
  const { t } = ctx;
  const topic = refusalOf(text);
  if (!topic) return { actions: [], text: t("claude.answers.general") };
  if (topic === "deploy") return { actions: [], text: t(`${KEY}.deploy`) };
  return PLACES[topic](text, ctx);
}

type Place = (text: string, ctx: IntentContext) => Promise<Answer>;

/** Una riga D con il link. */
function line(
  ctx: IntentContext,
  sentence: string,
  route: string | null,
  labelKey: string,
  code?: string,
  actions: ReadAction[] = [],
): Answer {
  return {
    actions,
    text: ctx.t(`${KEY}.${sentence}`),
    place: { route, labelKey: `${KEY}.${labelKey}`, ...(code ? { labelParams: { code } } : {}) },
  };
}

/** «Non trovo X»: identica per un codice invisibile, inesistente o eliminato (R-G5). */
function notFound(ctx: IntentContext, code: string, actions: ReadAction[] = []): Answer {
  return {
    actions: actions.map((a) => ({ ...a, ...resulted(ctx.t, "claude.answers.actions.notFound") })),
    text: ctx.t("claude.answers.explain.notFound", { code }),
  };
}

/**
 * La task del primo codice di task (non un server): la task e la sua
 * lettura, la risposta «non la trovo», o niente se il testo non ne nomina.
 */
async function taskOf(
  text: string,
  ctx: IntentContext,
): Promise<{ task: Task; projectCode: string; lookup: ReadAction } | { answer: Answer } | null> {
  const ref = findCodes(text).find((c) => c.kind === "task" && c.projectCode !== "SRV");
  if (!ref) return null;
  const lookup = {
    tool: "get_ticket",
    ...labelled(ctx.t, "claude.answers.actions.lookup", { code: ref.code }),
  };
  const task = await ctx.read.getTaskByCode(ref.code);
  if (!task) return { answer: notFound(ctx, ref.code, [lookup]) };
  const project = (await ctx.read.listProjects()).find((p) => p.id === task.projectId);
  if (!project) return { answer: notFound(ctx, ref.code, [lookup]) };
  return { task, projectCode: project.code, lookup };
}

/**
 * Il progetto nominato (codice, nome) o quello del contesto. Un progetto
 * nominato che chi chiede non vede ha la frase di uno che non esiste.
 */
async function projectOf(
  text: string,
  ctx: IntentContext,
): Promise<{ project: Project | null } | { answer: Answer }> {
  const { project, named } = findProject(text, await ctx.read.listProjects(), ctx.contextProjectId);
  if (named && !project) {
    return {
      answer: {
        actions: [],
        text: ctx.t("claude.answers.status.projectNotFound", { code: named }),
      },
    };
  }
  return { project };
}

const taskHref = (projectCode: string, code: string) => `#/p/${projectCode}/tasks?task=${code}`;

const PLACES: Record<RefusedTopic, Place> = {
  /** La scheda del piano: il pannello della task. */
  async approve_plan(text, ctx) {
    const found = await taskOf(text, ctx);
    if (!found) return line(ctx, "approvePlan", "#/claude?scope=live", "liveSessions");
    if ("answer" in found) return found.answer;
    const { task, projectCode, lookup } = found;
    return line(
      ctx,
      "approvePlan",
      taskHref(projectCode, task.code),
      "approvePlanLink",
      task.code,
      [lookup],
    );
  },

  /** La coda di rilascio del progetto (della task, se il testo ne nomina una). */
  async merge(text, ctx) {
    const found = await taskOf(text, ctx);
    if (found && "answer" in found) return found.answer;
    let code = found?.projectCode;
    if (!code) {
      const p = await projectOf(text, ctx);
      if ("answer" in p) return p.answer;
      code = p.project?.code;
    }
    const actions = found ? [found.lookup] : [];
    return code
      ? line(ctx, "merge", `#/p/${code}/releases`, "mergeLink", code, actions)
      : line(ctx, "merge", null, "mergeLink");
  },

  /**
   * La conversazione con la domanda aperta di Claude sulla task; senza una
   * domanda aperta, la task (e l'etichetta non dice «la domanda»).
   */
  async answer_question(text, ctx) {
    const found = await taskOf(text, ctx);
    if (!found) return line(ctx, "answerQuestion", "#/claude?scope=live", "liveSessions");
    if ("answer" in found) return found.answer;
    const { task, projectCode, lookup } = found;
    const live = await ctx.read.listConversations({ scope: "live", taskId: task.id });
    const asking = live.find((c) => c.state === "awaiting_answer");
    return asking
      ? line(ctx, "answerQuestion", `#/claude/${asking.id}`, "answerQuestionLink", task.code, [
          lookup,
        ])
      : line(
          ctx,
          "answerQuestion",
          taskHref(projectCode, task.code),
          "answerQuestionTask",
          task.code,
          [lookup],
        );
  },

  /**
   * «Record a decision» con la task scelta e il testo VUOTO: la decisione
   * del messaggio non entra nel link (il registro lo scrivono le persone).
   */
  async record_decision(text, ctx) {
    const found = await taskOf(text, ctx);
    if (found && "answer" in found) return found.answer;
    if (found) {
      const { task, projectCode, lookup } = found;
      return line(
        ctx,
        "recordDecision",
        `#/p/${projectCode}/overview?recordDecision=1&task=${task.code}`,
        "recordDecisionLink",
        task.code,
        [lookup],
      );
    }
    const p = await projectOf(text, ctx);
    if ("answer" in p) return p.answer;
    return p.project
      ? line(
          ctx,
          "recordDecision",
          `#/p/${p.project.code}/overview?recordDecision=1`,
          "recordDecisionProject",
          p.project.code,
        )
      : line(ctx, "recordDecision", null, "recordDecisionLink");
  },

  /** Il costruttore dell'automazione nominata; senza codice, le Automations. */
  async activate_automation(text, ctx) {
    const m = /\b([a-z]{2,4}-a\d+|aut-\d+)\b/i.exec(text);
    if (!m) return line(ctx, "activateAutomation", "#/automations", "automations");
    const code = m[1]!.toUpperCase();
    const lookup = {
      tool: "get_automation",
      ...labelled(ctx.t, "claude.answers.actions.lookup", { code }),
    };
    const seen = (await ctx.read.listAutomations()).find((a) => a.code === code);
    if (!seen) return notFound(ctx, code, [lookup]);
    return line(
      ctx,
      "activateAutomation",
      `#/automations/${code}/edit`,
      "activateAutomationLink",
      code,
      [lookup],
    );
  },

  /** Il dialogo vero, aperto dal link: mai un valore nella conversazione. */
  async secret(text, ctx) {
    const plain = normalize(text);
    if (/\b(invite|invitation|invito|inviti)\b/.test(plain))
      return line(ctx, "secret", "#/admin/people?invite=1", "secretInvite");
    if (/\b(webhook|ingestion|integration|integrazione|env|environment|ambiente)\b/.test(plain)) {
      const p = await projectOf(text, ctx);
      if ("answer" in p) return p.answer;
      if (p.project) {
        return line(
          ctx,
          "secret",
          `#/p/${p.project.code}/settings/integration`,
          "secretIntegration",
          p.project.code,
        );
      }
    }
    return line(ctx, "secret", "#/preferences/tokens", "secretTokens");
  },

  /** La pagina del server, nel primo progetto visibile che lo usa. */
  async server(text, ctx) {
    const m = /\bsrv-(\d+)\b/i.exec(text);
    if (!m) {
      const p = await projectOf(text, ctx);
      if ("answer" in p) return p.answer;
      return p.project
        ? line(ctx, "server", `#/p/${p.project.code}/servers`, "serverProject", p.project.code)
        : line(ctx, "server", null, "serverLink");
    }
    const code = `SRV-${m[1]}`;
    const lookup = {
      tool: "get_server",
      ...labelled(ctx.t, "claude.answers.actions.lookup", { code }),
    };
    for (const project of await ctx.read.listProjects()) {
      const rows = await ctx.read.listProjectServers(project.id);
      if (rows.some((r) => r.code === code)) {
        return line(ctx, "server", `#/p/${project.code}/servers/${code}`, "serverLink", code, [
          lookup,
        ]);
      }
    }
    return notFound(ctx, code, [lookup]);
  },

  /** Il campo dove si scrive: Supporto del progetto se si parla del cliente, altrimenti la Posta. */
  async send(text, ctx) {
    const plain = normalize(text);
    if (/\b(customers?|clients?|cliente|clienti|support|supporto)\b/.test(plain)) {
      const p = await projectOf(text, ctx);
      if ("answer" in p) return p.answer;
      if (p.project) {
        return line(ctx, "send", `#/p/${p.project.code}/support`, "sendSupport", p.project.code);
      }
    }
    return line(ctx, "send", "#/mail", "sendMail");
  },
};
