import { INSTANCE_ORIGIN } from "../admin/secrets";
import { recordChange } from "../changelog/index";
import { changedFields } from "../changelog/settingValues";
import { gate, now, state } from "../store";
import { forbidden, writer } from "../writer";
import { canI, refuse } from "./common";
import type { OutgoingWebhook, TestOutcome } from "./state";
import type { InstanceResult } from "./types";

// Il webhook in uscita (area 9b, Task 4): un messaggio a un canale di chat
// o a un endpoint quando succede qualcosa in un progetto. Si legge e si
// scrive con `settings.manage`. L'URL NON è un segreto (maintainer, 30 ott
// 2026): si rilegge in chiaro, entra nel prima/dopo del registro e salvarlo
// non chiede la riconferma; il webhook non ha altri segreti (niente chiave
// di firma, come sul web).
//
// Gli eventi sono i 13 del web più 8 del catalogo 8a/8b, 21 in tutto, nei
// sei gruppi dello shape `admin-integrations.md` [IN 4] (confermata dal
// maintainer il 30 ott 2026). Fuori, col motivo: `pr.opened` (rumore, e
// quella di Claude è già `job.pr_opened`), `task.created` (coincide con
// `ticket.created`), `pr.corrected` (avviso personale), le risposte dei
// clienti (`support.customer_replied`: porterebbero fuori le parole di un
// cliente, maintainer), `google.proposal`, la posta e `security.alert`.
// `saveWebhook` rifiuta un id che non è qui: un evento escluso non si
// accende nemmeno per sbaglio.

const MANAGE = "settings.manage";
const OBJECT = { type: "webhook", id: "webhook", label: "webhook" };

export type WebhookGroup = "tasks" | "work" | "prs" | "docs" | "servers" | "project";
export type WebhookFormat = OutgoingWebhook["format"];

/** I 21 eventi, nell'ordine e nei gruppi dello shape. `monitor` copre anche `server.trouble`, `server.down`, `server.recovered`. */
export const WEBHOOK_EVENTS = [
  { id: "ticket.created", source: "web", group: "tasks" },
  { id: "task.created_by_automation", source: "catalog", group: "tasks" },
  { id: "support.request", source: "catalog", group: "tasks" },
  { id: "job.plan_review", source: "web", group: "work" },
  { id: "job.awaiting_input", source: "web", group: "work" },
  { id: "job.held", source: "web", group: "work" },
  { id: "job.budget_held", source: "web", group: "work" },
  { id: "job.failed", source: "web", group: "work" },
  { id: "job.pr_opened", source: "web", group: "prs" },
  { id: "job.pr_closed", source: "web", group: "prs" },
  { id: "review.completed", source: "web", group: "prs" },
  { id: "pr.analysis_issues", source: "catalog", group: "prs" },
  { id: "release.merged", source: "catalog", group: "prs" },
  { id: "release.succeeded", source: "catalog", group: "prs" },
  { id: "release.failed", source: "catalog", group: "prs" },
  { id: "docs.limit_paused", source: "web", group: "docs" },
  { id: "docs.release_note", source: "catalog", group: "docs" },
  { id: "monitor", source: "web", group: "servers" },
  { id: "server.diagnosis_ready", source: "catalog", group: "servers" },
  { id: "project.pulse", source: "web", group: "project" },
  { id: "project.brief", source: "web", group: "project" },
] as const satisfies readonly { id: string; source: "web" | "catalog"; group: WebhookGroup }[];

export type WebhookEventId = (typeof WEBHOOK_EVENTS)[number]["id"];

const EVENT_IDS: ReadonlySet<string> = new Set(WEBHOOK_EVENTS.map((e) => e.id));
const FORMATS: ReadonlySet<string> = new Set(["slack", "discord", "generic"]);

export interface WebhookView {
  enabled: boolean;
  format: WebhookFormat;
  /** In chiaro: lo legge chi ha `settings.manage`. */
  url: string | null;
  /** Ognuno dei 21 eventi, acceso o spento. */
  events: Record<WebhookEventId, boolean>;
  lastTest: { at: string; outcome: TestOutcome } | null;
}

const allEvents = (from: Record<string, boolean>): Record<WebhookEventId, boolean> =>
  Object.fromEntries(WEBHOOK_EVENTS.map((e) => [e.id, from[e.id] === true])) as Record<
    WebhookEventId,
    boolean
  >;

/** Gli eventi accesi, nell'ordine dello shape: è il valore della voce del registro. */
const onEvents = (from: Record<string, boolean>): string[] =>
  WEBHOOK_EVENTS.filter((e) => from[e.id] === true).map((e) => e.id);

const isHttps = (value: string): boolean => {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname !== "";
  } catch {
    return false;
  }
};

/** Il webhook, con l'URL in chiaro e tutti gli eventi. */
export async function getWebhook(): Promise<WebhookView> {
  const me = await gate("instance.getWebhook");
  if (!canI(me, MANAGE)) throw forbidden();
  const w = state.instance.webhook;
  return {
    enabled: w.enabled,
    format: w.format,
    url: w.url,
    events: allEvents(w.events),
    lastTest: w.lastTest ? { ...w.lastTest } : null,
  };
}

/**
 * Salva tutto il modulo, senza riconferma. `invalid: "url"` per un
 * indirizzo non https, o mancante coi messaggi accesi; `invalid: "events"`
 * per un evento che non è fra i 21. La voce `webhook.changed` ha i soli
 * campi cambiati, l'URL compreso. Cambiare indirizzo o formato rimette la
 * prova a «non ancora provata».
 */
export async function saveWebhook(input: {
  enabled: boolean;
  format: WebhookFormat;
  url: string | null;
  events: Record<string, boolean>;
}): Promise<InstanceResult> {
  const me = await writer("instance.saveWebhook");
  if (!canI(me, MANAGE)) return refuse.forbidden();
  if (!FORMATS.has(input.format)) return refuse.invalid("format");
  const url = input.url?.trim() || null;
  if (url !== null && !isHttps(url)) return refuse.invalid("url");
  if (input.enabled && url === null) return refuse.invalid("url");
  if (!Object.keys(input.events).every((id) => EVENT_IDS.has(id))) return refuse.invalid("events");

  const w = state.instance.webhook;
  const events = allEvents(input.events);
  const diff = changedFields(
    { enabled: w.enabled, format: w.format, url: w.url, events: onEvents(w.events) },
    { enabled: input.enabled, format: input.format, url, events: onEvents(events) },
  );
  if (!diff) return { ok: true };
  const retest = w.url !== url || w.format !== input.format;
  w.enabled = input.enabled;
  w.format = input.format;
  w.url = url;
  w.events = events;
  if (retest) w.lastTest = null;
  recordChange({ kind: "webhook.changed", actorId: me, projectId: null, object: OBJECT, ...diff });
  return { ok: true };
}

/**
 * Manda una prova: l'esito scelto nel riquadro «Prototype only»
 * (`simulateNextTest("webhook", …)`, vale una volta), altrimenti `ok`. Non
 * si contatta niente di vero; nessuna voce.
 */
export async function testWebhook(): Promise<InstanceResult<{ outcome: TestOutcome }>> {
  const me = await writer("instance.testWebhook");
  if (!canI(me, MANAGE)) return refuse.forbidden();
  const w = state.instance.webhook;
  if (w.url === null) return refuse.invalid("url");
  const next = state.instance.simulate.nextTest;
  const outcome = next.webhook ?? "ok";
  delete next.webhook;
  w.lastTest = { at: now(), outcome };
  return { ok: true, outcome };
}

// --- anteprima -------------------------------------------------------------

type Lang = "en" | "it";
type Words = Record<Lang, string>;

/** I dati d'esempio, fittizi e dichiarati («Example data»). */
const TASK = { code: "ACQ-42", title: "Export the monthly report as PDF" };
const PROJECT = "ACQ";
const taskUrl = `${INSTANCE_ORIGIN}/p/${PROJECT}/tasks/${TASK.code}`;
const prUrl = "https://bitbucket.org/audin/audin-app/pull-requests/128";

const OPEN: Words = { en: "Open", it: "Apri" };
const PR: Words = { en: "Pull request", it: "Pull request" };
const TASK_LINK: Words = { en: "Task", it: "Task" };

interface Sample {
  /** La frase, con `ref` (il codice della task, già formattato) dove serve. */
  text: Record<Lang, (ref: string) => string>;
  links: { label: Words; url: string }[];
  /** L'evento riguarda una task: il JSON porta codice e titolo. */
  task: boolean;
}

const t = TASK.title;
const PREVIEW: Record<WebhookEventId, Sample> = {
  "ticket.created": {
    text: {
      en: (r) => `New task in ${PROJECT}: ${r} ${t}`,
      it: (r) => `Nuova task in ${PROJECT}: ${r} ${t}`,
    },
    links: [{ label: OPEN, url: taskUrl }],
    task: true,
  },
  "task.created_by_automation": {
    text: {
      en: (r) => `The automation “Weekly triage” created a task in ${PROJECT}: ${r} ${t}`,
      it: (r) => `L'automazione «Triage settimanale» ha creato una task in ${PROJECT}: ${r} ${t}`,
    },
    links: [{ label: OPEN, url: taskUrl }],
    task: true,
  },
  "support.request": {
    text: {
      en: () => `New request in the ${PROJECT} backlog: “Export to Excel too”`,
      it: () => `Nuova richiesta nel backlog di ${PROJECT}: «Esportare anche in Excel»`,
    },
    links: [{ label: OPEN, url: `${INSTANCE_ORIGIN}/p/${PROJECT}/requests` }],
    task: false,
  },
  "job.plan_review": {
    text: {
      en: (r) => `Claude's plan for ${r} ${t} is waiting for approval`,
      it: (r) => `Il piano di Claude per ${r} ${t} aspetta l'approvazione`,
    },
    links: [{ label: { en: "Review", it: "Rivedi" }, url: taskUrl }],
    task: true,
  },
  "job.awaiting_input": {
    text: {
      en: (r) => `Claude asked a question on ${r} ${t}`,
      it: (r) => `Claude ha fatto una domanda su ${r} ${t}`,
    },
    links: [{ label: { en: "Answer", it: "Rispondi" }, url: taskUrl }],
    task: true,
  },
  "job.held": {
    text: {
      en: (r) => `Work on ${r} ${t} is on hold`,
      it: (r) => `Il lavoro su ${r} ${t} è in attesa`,
    },
    links: [{ label: OPEN, url: taskUrl }],
    task: true,
  },
  "job.budget_held": {
    text: {
      en: (r) => `Work on ${r} ${t} is on hold: the monthly AI budget is reached`,
      it: (r) => `Il lavoro su ${r} ${t} è in attesa: il budget AI del mese è raggiunto`,
    },
    links: [{ label: OPEN, url: taskUrl }],
    task: true,
  },
  "job.failed": {
    text: {
      en: (r) => `Claude's work on ${r} ${t} failed`,
      it: (r) => `Il lavoro di Claude su ${r} ${t} non è riuscito`,
    },
    links: [{ label: OPEN, url: taskUrl }],
    task: true,
  },
  "job.pr_opened": {
    text: {
      en: (r) => `Claude opened a pull request for ${r} ${t} · $1.84`,
      it: (r) => `Claude ha aperto una pull request per ${r} ${t} · $1.84`,
    },
    links: [
      { label: PR, url: prUrl },
      { label: TASK_LINK, url: taskUrl },
    ],
    task: true,
  },
  "job.pr_closed": {
    text: {
      en: (r) => `The pull request for ${r} ${t} was closed without merge`,
      it: (r) => `La pull request per ${r} ${t} è stata chiusa senza merge`,
    },
    links: [
      { label: PR, url: prUrl },
      { label: TASK_LINK, url: taskUrl },
    ],
    task: true,
  },
  "review.completed": {
    text: {
      en: (r) => `The review of the pull request for ${r} ${t} is done: 2 comments`,
      it: (r) => `La revisione della pull request per ${r} ${t} è fatta: 2 commenti`,
    },
    links: [
      { label: PR, url: prUrl },
      { label: TASK_LINK, url: taskUrl },
    ],
    task: true,
  },
  "pr.analysis_issues": {
    text: {
      en: () => `Claude found 3 problems in pull request #128 of audin-app`,
      it: () => `Claude ha trovato 3 problemi nella pull request #128 di audin-app`,
    },
    links: [{ label: PR, url: prUrl }],
    task: false,
  },
  "release.merged": {
    text: {
      en: () => `Pull request #128 of audin-app was merged to production`,
      it: () => `La pull request #128 di audin-app è stata mergiata in produzione`,
    },
    links: [{ label: PR, url: prUrl }],
    task: false,
  },
  "release.succeeded": {
    text: {
      en: () => `The release of audin-app 2.4.0 succeeded`,
      it: () => `Il rilascio di audin-app 2.4.0 è riuscito`,
    },
    links: [{ label: OPEN, url: `${INSTANCE_ORIGIN}/p/${PROJECT}/releases` }],
    task: false,
  },
  "release.failed": {
    text: {
      en: () => `The release of audin-app 2.4.0 failed`,
      it: () => `Il rilascio di audin-app 2.4.0 non è riuscito`,
    },
    links: [{ label: OPEN, url: `${INSTANCE_ORIGIN}/p/${PROJECT}/releases` }],
    task: false,
  },
  "docs.limit_paused": {
    text: {
      en: () => `The Docs of audin-app are paused: the account limit is reached`,
      it: () => `I Docs di audin-app sono in pausa: il limite dell'account è raggiunto`,
    },
    links: [{ label: OPEN, url: `${INSTANCE_ORIGIN}/p/${PROJECT}/docs` }],
    task: false,
  },
  "docs.release_note": {
    text: {
      en: () => `New release note for audin-app`,
      it: () => `Nuova nota di rilascio per audin-app`,
    },
    links: [{ label: OPEN, url: `${INSTANCE_ORIGIN}/p/${PROJECT}/docs` }],
    task: false,
  },
  monitor: {
    text: {
      en: () => `Server SRV-2 (acq-prod-1) is down`,
      it: () => `Il server SRV-2 (acq-prod-1) è fermo`,
    },
    links: [{ label: OPEN, url: `${INSTANCE_ORIGIN}/p/${PROJECT}/servers/SRV-2` }],
    task: false,
  },
  "server.diagnosis_ready": {
    text: {
      en: () => `Claude's diagnosis of SRV-2 (acq-prod-1) is ready`,
      it: () => `La diagnosi di Claude su SRV-2 (acq-prod-1) è pronta`,
    },
    links: [{ label: OPEN, url: `${INSTANCE_ORIGIN}/p/${PROJECT}/servers/SRV-2` }],
    task: false,
  },
  "project.pulse": {
    text: {
      en: () => `${PROJECT} has been idle for 9 days: 3 backlog items to start from`,
      it: () => `${PROJECT} è fermo da 9 giorni: 3 voci di backlog da cui ripartire`,
    },
    links: [{ label: OPEN, url: `${INSTANCE_ORIGIN}/p/${PROJECT}` }],
    task: false,
  },
  "project.brief": {
    text: {
      en: () => `The weekly brief of ${PROJECT} is ready`,
      it: () => `Il brief settimanale di ${PROJECT} è pronto`,
    },
    links: [{ label: OPEN, url: `${INSTANCE_ORIGIN}/p/${PROJECT}` }],
    task: false,
  },
};

/**
 * Il messaggio d'esempio di un evento in un formato, come la `LivePreview`
 * del web: Slack (`*grassetto*`, `<url|etichetta>`), Discord
 * (`**grassetto**`, `[etichetta](url)`) o JSON generico (campi piatti, in
 * un blocco). È nella lingua dei contenuti d'istanza, come i messaggi veri.
 * Dati d'esempio fittizi; nessuna lettura di dati veri, quindi nessun
 * cancello.
 */
export function previewWebhook(eventId: WebhookEventId, format: WebhookFormat): string {
  const sample = PREVIEW[eventId];
  if (!sample) throw new Error(`invalid: event`);
  const lang: Lang = state.instance.budget.contentLanguage;
  if (format === "generic") {
    const body: Record<string, unknown> = {
      event: eventId,
      project: PROJECT,
      message: sample.text[lang](TASK.code),
      url: sample.links[0]!.url,
    };
    if (sample.task) Object.assign(body, { code: TASK.code, title: TASK.title });
    return JSON.stringify(body, null, 2);
  }
  const ref = format === "slack" ? `*${TASK.code}*` : `**${TASK.code}**`;
  const links = sample.links
    .map((l) =>
      format === "slack" ? `<${l.url}|${l.label[lang]}>` : `[${l.label[lang]}](${l.url})`,
    )
    .join(" · ");
  return `${sample.text[lang](ref)} ${links}`;
}
