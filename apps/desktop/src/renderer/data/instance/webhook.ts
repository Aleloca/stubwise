import { INSTANCE_ORIGIN, forgetSecret, storeSecret } from "../admin/secrets";
import { recordChange } from "../changelog/index";
import { changedFields } from "../changelog/settingValues";
import { gate, now, state } from "../store";
import { forbidden, notFound, writer } from "../writer";
import { canI, reauthRefusal, refuse } from "./common";
import type { OutgoingWebhook, WebhookTestOutcome } from "./state";
import type { InstanceResult } from "./types";
import { WEBHOOK_EVENTS, WEBHOOK_LIMIT } from "./constants";

export { WEBHOOK_EVENTS } from "./constants";

// I webhook in uscita (area 9b, Task 4; integrazione area 9, F3, D-10 = b):
// un ELENCO, ognuno col suo nome, indirizzo, formato, eventi e segreto. Un
// webhook non riceve mai un evento che non ha scelto. Si leggono e si
// scrivono con `integrations.manage` (H-1). L'URL NON è un segreto
// (maintainer, 30 ott 2026): si rilegge in chiaro, entra nel prima/dopo del
// registro e cambiarlo non chiede la riconferma. Il SEGRETO (la firma
// `X-Stubwise-Signature` degli invii) lo genera Stubwise: si vede una volta,
// alla creazione e alla rigenerazione, entrambe con la riconferma, come
// l'eliminazione; nessuna lettura lo riporta (`secretSet`, `secretRotatedAt`).
// Al più 20 webhook (`webhook_limit`), come il server.
//
// Gli eventi sono i 21 di `WEBHOOK_EVENTS` (13 del web più 8 del catalogo
// 8a/8b, shape `admin-integrations.md` [IN 4], confermata dal maintainer il
// 30 ott 2026). Fuori, col motivo: `pr.opened` (rumore, e quella di Claude è
// già `job.pr_opened`), `task.created` (coincide con `ticket.created`),
// `pr.corrected` (avviso personale), le risposte dei clienti (porterebbero
// fuori le parole di un cliente, maintainer), `google.proposal`, la posta e
// `security.alert`. Un id che non è qui si rifiuta (`invalid: "events"`).

const MANAGE = "integrations.manage";

export { WEBHOOK_LIMIT } from "./constants";

export type WebhookGroup = "tasks" | "work" | "prs" | "docs" | "servers" | "project";
export type WebhookFormat = OutgoingWebhook["format"];

export type WebhookEventId = (typeof WEBHOOK_EVENTS)[number]["id"];

const EVENT_IDS: ReadonlySet<string> = new Set(WEBHOOK_EVENTS.map((e) => e.id));
const FORMATS: ReadonlySet<string> = new Set(["slack", "discord", "generic"]);

/** Un webhook come lo legge chi lo gestisce: mai il segreto. */
export interface WebhookView {
  id: string;
  name: string;
  /** In chiaro: non è un segreto. */
  url: string;
  format: WebhookFormat;
  enabled: boolean;
  /** Gli eventi scelti, nell'ordine dello shape. */
  events: WebhookEventId[];
  secretSet: boolean;
  secretRotatedAt: string | null;
  createdAt: string;
  lastTest: { at: string; outcome: WebhookTestOutcome; status: number | null } | null;
  /**
   * Nella build app (review F3, I2): il server ha un formato o eventi che il
   * client non conosce. La pagina non lo modifica (o non ne cambia gli eventi)
   * per non toglierglieli. Nel prototipo non capita.
   */
  formatUnknown?: boolean;
  unknownEvents?: boolean;
}

export interface WebhookInput {
  name: string;
  url: string;
  format: WebhookFormat;
  enabled?: boolean;
  events: string[];
}

/** Gli eventi scelti, senza doppi, nell'ordine dello shape. */
const ordered = (ids: readonly string[]): WebhookEventId[] =>
  WEBHOOK_EVENTS.filter((e) => ids.includes(e.id)).map((e) => e.id);

const isHttps = (value: string): boolean => {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname !== "";
  } catch {
    return false;
  }
};

const viewOf = (w: OutgoingWebhook): WebhookView => ({
  id: w.id,
  name: w.name,
  url: w.url,
  format: w.format,
  enabled: w.enabled,
  events: ordered(w.events),
  secretSet: w.secretId !== null,
  secretRotatedAt: w.secretRotatedAt,
  createdAt: w.createdAt,
  lastTest: w.lastTest ? { ...w.lastTest } : null,
});

const objectOf = (w: OutgoingWebhook) => ({ type: "webhook", id: w.id, label: w.name });

/** Il motivo di un campo che non va, o `null`. */
function invalidOf(input: Partial<WebhookInput>): string | null {
  if (input.name !== undefined && !input.name.trim()) return "name";
  if (input.url !== undefined && !isHttps(input.url.trim())) return "url";
  if (input.format !== undefined && !FORMATS.has(input.format)) return "format";
  if (input.events !== undefined && !input.events.every((id) => EVENT_IDS.has(id))) return "events";
  return null;
}

/** I webhook, in ordine di creazione. */
export async function listWebhooks(): Promise<WebhookView[]> {
  const me = await gate("instance.listWebhooks");
  if (!canI(me, MANAGE)) throw forbidden();
  return state.instance.webhooks.map(viewOf);
}

/** Un webhook (la sua pagina). `not_found` se non c'è. */
export async function getWebhook(id: string): Promise<WebhookView> {
  const me = await gate("instance.getWebhook");
  if (!canI(me, MANAGE)) throw forbidden();
  const w = state.instance.webhooks.find((x) => x.id === id);
  if (!w) throw notFound();
  return viewOf(w);
}

let counter = 0;

/**
 * Un webhook nuovo, con la riconferma (nasce un segreto): la vista più
 * `secret`, l'UNICA volta che esce. Al più `WEBHOOK_LIMIT`.
 */
export async function createWebhook(
  input: WebhookInput,
): Promise<InstanceResult<{ webhook: WebhookView; secret: string }>> {
  const me = await writer("instance.createWebhook");
  if (!canI(me, MANAGE)) return refuse.forbidden();
  const bad = invalidOf(input);
  if (bad) return refuse.invalid(bad);
  if (state.instance.webhooks.length >= WEBHOOK_LIMIT) return refuse.invalid("webhook_limit");
  const reauth = reauthRefusal(me, "instance.createWebhook");
  if (reauth) return reauth;
  const id = `wh-${++counter}-${Date.parse(now())}`;
  const secret = storeSecret("outgoing_webhook_secret", id);
  const w: OutgoingWebhook = {
    id,
    name: input.name.trim(),
    url: input.url.trim(),
    format: input.format,
    enabled: input.enabled ?? true,
    events: ordered(input.events),
    secretId: secret.id,
    secretRotatedAt: now(),
    createdAt: now(),
    lastTest: null,
  };
  state.instance.webhooks.push(w);
  recordChange({
    kind: "webhook.created",
    actorId: me,
    projectId: null,
    object: objectOf(w),
    // Come il server: il formato e gli eventi scelti (valori stabili).
    params: { format: w.format, events: w.events.join(",") },
  });
  return { ok: true, webhook: viewOf(w), secret: secret.value };
}

/**
 * Cambia nome, indirizzo, formato, eventi o stato. Solo un indirizzo nuovo
 * chiede la riconferma (maintainer, 18 nov 2026). La voce `webhook.updated` ha i soli campi cambiati;
 * cambiare indirizzo o formato rimette la prova a «non ancora provata».
 */
export async function updateWebhook(
  id: string,
  patch: Partial<WebhookInput>,
): Promise<InstanceResult> {
  return updateWebhookAs(await writer("instance.updateWebhook"), id, patch);
}

/** La forma sincrona di `updateWebhook` per chi ha già passato il cancello (il catalogo di Claude, area 10a). */
export function updateWebhookAs(
  me: string,
  id: string,
  patch: Partial<WebhookInput>,
): InstanceResult {
  if (!canI(me, MANAGE)) return refuse.forbidden();
  const w = state.instance.webhooks.find((x) => x.id === id);
  if (!w) return refuse.notFound();
  const bad = invalidOf(patch);
  if (bad) return refuse.invalid(bad);
  const next = {
    name: patch.name?.trim() ?? w.name,
    url: patch.url?.trim() ?? w.url,
    format: patch.format ?? w.format,
    enabled: patch.enabled ?? w.enabled,
    events: patch.events ? ordered(patch.events) : ordered(w.events),
  };
  // Un indirizzo NUOVO vuole la riconferma (maintainer, 18 nov 2026): dove
  // vanno i messaggi. Il resto della patch no.
  if (next.url !== w.url) {
    const reauth = reauthRefusal(me, "instance.updateWebhook");
    if (reauth) return reauth;
  }
  const diff = changedFields(
    { name: w.name, url: w.url, format: w.format, enabled: w.enabled, events: ordered(w.events) },
    next,
  );
  if (!diff) return { ok: true };
  const retest = w.url !== next.url || w.format !== next.format;
  Object.assign(w, next);
  if (retest) w.lastTest = null;
  recordChange({
    kind: "webhook.updated",
    actorId: me,
    projectId: null,
    object: objectOf(w),
    ...diff,
  });
  return { ok: true };
}

/** Un segreto nuovo, con la riconferma: il vecchio smette di firmare; il nuovo si vede una volta. */
export async function regenerateWebhookSecret(
  id: string,
): Promise<InstanceResult<{ secret: string; secretRotatedAt: string }>> {
  const me = await writer("instance.regenerateWebhookSecret");
  if (!canI(me, MANAGE)) return refuse.forbidden();
  const w = state.instance.webhooks.find((x) => x.id === id);
  if (!w) return refuse.notFound();
  const reauth = reauthRefusal(me, "instance.regenerateWebhookSecret");
  if (reauth) return reauth;
  if (w.secretId) forgetSecret(w.secretId);
  const secret = storeSecret("outgoing_webhook_secret", id);
  w.secretId = secret.id;
  w.secretRotatedAt = now();
  // La voce non porta valori: «sostituito», mai il segreto.
  recordChange({
    kind: "webhook.secret_replaced",
    actorId: me,
    projectId: null,
    object: objectOf(w),
  });
  return { ok: true, secret: secret.value, secretRotatedAt: w.secretRotatedAt };
}

/** Elimina un webhook, con la riconferma: non riceve più niente, il segreto si dimentica. */
export async function deleteWebhook(id: string): Promise<InstanceResult> {
  const me = await writer("instance.deleteWebhook");
  if (!canI(me, MANAGE)) return refuse.forbidden();
  const w = state.instance.webhooks.find((x) => x.id === id);
  if (!w) return refuse.notFound();
  const reauth = reauthRefusal(me, "instance.deleteWebhook");
  if (reauth) return reauth;
  if (w.secretId) forgetSecret(w.secretId);
  state.instance.webhooks = state.instance.webhooks.filter((x) => x.id !== id);
  recordChange({ kind: "webhook.deleted", actorId: me, projectId: null, object: objectOf(w) });
  return { ok: true };
}

/**
 * Manda una prova a un webhook, anche spento: l'esito scelto nel riquadro
 * «Prototype only» (`simulateNextTest("webhook", …)`, vale una volta),
 * altrimenti `ok`. Non si contatta niente di vero; nessuna voce.
 */
/** Il codice di risposta che il prototipo finge per ogni esito. */
const FAKE_STATUS: Record<WebhookTestOutcome, number | null> = {
  ok: 200,
  invalid_credentials: 401,
  destination_error: 500,
  unreachable: null,
};

export async function testWebhook(
  id: string,
): Promise<InstanceResult<{ outcome: WebhookTestOutcome }>> {
  const me = await writer("instance.testWebhook");
  if (!canI(me, MANAGE)) return refuse.forbidden();
  const w = state.instance.webhooks.find((x) => x.id === id);
  if (!w) return refuse.notFound();
  const simulate = state.instance.simulate;
  const outcome: WebhookTestOutcome = simulate.nextWebhookTest ?? "ok";
  delete simulate.nextWebhookTest;
  w.lastTest = { at: now(), outcome, status: FAKE_STATUS[outcome] };
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
export async function previewWebhook(
  eventId: WebhookEventId,
  format: WebhookFormat,
): Promise<string> {
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
