import { copy, gate, now, state } from "../store";
import type { AutomationSourceEvent } from "@stubwise/shared";
import type { AutomationSource, DataField, FieldType, WebhookExamplePreview } from "../types";
import { forbidden, invalid, notFound, writer } from "../writer";
import { clientKeyOf, deriveFields, fieldKeys, mergeFields, visitSteps } from "@stubwise/shared";
import { viewRun } from "./runView";
import { publishedVersion } from "./runner";
import { canManageIntegrations, canSeeAutomation, canSeeRun } from "./visibility";

// Le sorgenti create e curate da chi gestisce le integrazioni (shape
// automation-sources.md §6): un webhook in arrivo nuovo, il nome, l'indirizzo
// (che si può rigenerare), l'esempio da cui derivano i campi, l'etichetta e
// il tipo di un campo; e i suggerimenti «From recent events» per la tabella
// cliente → progetto. Tutto con `integrations.manage`.

function managed(me: string, id: string): AutomationSource {
  if (!canManageIntegrations(me)) throw forbidden();
  const source = state.automationSources.find((s) => s.id === id);
  if (!source) throw notFound();
  return source;
}

function webhook(me: string, id: string): AutomationSource {
  const source = managed(me, id);
  if (source.kind !== "webhook") throw invalid("not_webhook");
  return source;
}

/** Un indirizzo nuovo (finto, deterministico: dal contatore dello store). */
function newAddress(): string {
  const n = ++state.counter;
  const hex = ((n * 2654435761) >>> 0).toString(16).padStart(8, "0");
  return `https://stubwise.example/hooks/in/${hex}${n.toString(16).padStart(4, "0")}`;
}

/** «Ordini e-shop»: un webhook nuovo, collegato da chi lo crea, senza esempio né campi. */
export async function createWebhookSource(name: string): Promise<AutomationSource> {
  const me = await writer("automations.createWebhookSource");
  if (!canManageIntegrations(me)) throw forbidden();
  const clean = name.trim();
  if (!clean) throw invalid("name");
  const source: AutomationSource = {
    id: `src-wh-${state.counter + 1}`,
    kind: "webhook",
    name: clean,
    status: "connected",
    connectedById: me,
    connectedAt: now(),
    sampleEvents: [],
    fields: [],
    address: "",
  };
  source.address = newAddress();
  state.automationSources.push(source);
  return copy(source);
}

export async function renameSource(id: string, name: string): Promise<void> {
  const me = await writer("automations.renameSource");
  const source = managed(me, id);
  const clean = name.trim();
  if (!clean) throw invalid("name");
  source.name = clean;
}

/** «Generate a new address»: il vecchio smette subito di funzionare ([A 6]). */
export async function regenerateWebhookAddress(id: string): Promise<string> {
  const me = await writer("automations.regenerateWebhookAddress");
  const source = webhook(me, id);
  source.address = newAddress();
  return source.address;
}

// --- l'esempio e i campi --------------------------------------------------------------

// L'esempio e i campi: le regole di `@stubwise/shared` (`sourceFields.ts`,
// C-F4-2), le stesse del server e della prova.
export { deriveFields, labelFromKey } from "@stubwise/shared";

/** Un campo è usato da un'automazione se il flusso lo cita (testi, condizioni, ingressi). */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cites = (text: string, key: string) =>
  new RegExp(`\\{\\{\\s*${escape(key)}\\s*\\}\\}|"${escape(key)}"`).test(text);

/**
 * Le automazioni che chi guarda vede (R-G5) e che citano un campo nella
 * versione pubblicata o nella bozza (le versioni vecchie non girano più per
 * esecuzioni nuove). Un campo dentro un elenco (`prodotti.nome`) si cita
 * attraverso il `forEach` che scorre l'elenco: `{{<as>.nome}}`.
 */
function usedBy(me: string, source: AutomationSource, key: string): string[] {
  const [listKey, childKey] = splitListKey(source.fields, key);
  return state.automations
    .filter((a) => canSeeAutomation(me, a))
    .filter((a) => {
      const live = publishedVersion(a);
      const draft = a.versions.at(-1)!;
      return [live, draft].some((v) => {
        if (!v || v.flow.trigger.kind !== "source" || v.flow.trigger.sourceId !== source.id)
          return false;
        const text = JSON.stringify(v.flow.steps);
        if (listKey === null) return cites(text, key);
        let hit = false;
        visitSteps(v.flow.steps, (s) => {
          if (s.kind === "forEach" && s.list === listKey && cites(text, `${s.as}.${childKey}`))
            hit = true;
        });
        return hit;
      });
    })
    .map((a) => a.code);
}

/** `prodotti.nome` → `["prodotti", "nome"]` se `prodotti` è un elenco; altrimenti `[null, key]`. */
function splitListKey(fields: DataField[], key: string): [string | null, string] {
  const parent = fields.find((f) => f.type === "list" && key.startsWith(`${f.key}.`));
  return parent ? [parent.key, key.slice(parent.key.length + 1)] : [null, key];
}

function parseExample(json: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    throw invalid(`json: ${(e as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("json: object");
  return value as Record<string, unknown>;
}

function preview(me: string, source: AutomationSource, json: string): WebhookExamplePreview {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseExample(json);
  } catch (e) {
    return {
      error: (e as Error).message.replace(/^invalid: json: ?/, ""),
      fields: [],
      missing: [],
    };
  }
  const fields = mergeFields(deriveFields(parsed), source.fields);
  const kept = new Set(fieldKeys(fields));
  const missing = fieldKeys(source.fields)
    .filter((k) => !kept.has(k))
    .map((k) => ({
      key: k,
      label: source.fields.find((f) => f.key === k)?.label ?? k,
      usedBy: usedBy(me, source, k),
    }))
    .filter((m) => m.usedBy.length > 0);
  return { error: null, fields, missing };
}

/** «Replace example», prima di confermare: i campi che ne derivano e quelli usati che spariscono. */
export async function previewWebhookExample(
  id: string,
  json: string,
): Promise<WebhookExamplePreview> {
  const me = await gate("automations.previewWebhookExample");
  return preview(me, webhook(me, id), json);
}

/** Conferma l'esempio: diventa il primo evento d'esempio e ne derivano i campi. */
export async function setWebhookExample(id: string, json: string): Promise<DataField[]> {
  const me = await writer("automations.setWebhookExample");
  const source = webhook(me, id);
  const parsed = parseExample(json);
  source.fields = mergeFields(deriveFields(parsed), source.fields);
  source.sampleEvents = [parsed, ...source.sampleEvents.slice(1)];
  return copy(source.fields);
}

const FIELD_TYPES: readonly FieldType[] = [
  "text",
  "number",
  "date",
  "email",
  "person",
  "list",
  "file",
  "boolean",
];

/** L'etichetta e il tipo di un campo (anche di uno dentro un elenco: `prodotti.nome`). */
export async function updateWebhookField(
  id: string,
  key: string,
  patch: { label?: string; type?: FieldType },
): Promise<void> {
  const me = await writer("automations.updateWebhookField");
  const source = webhook(me, id);
  const find = (fields: DataField[], rest: string): DataField | undefined => {
    const direct = fields.find((f) => f.key === rest);
    if (direct) return direct;
    const parent = fields.find((f) => f.of && rest.startsWith(`${f.key}.`));
    return parent ? find(parent.of!, rest.slice(parent.key.length + 1)) : undefined;
  };
  const field = find(source.fields, key);
  if (!field) throw notFound();
  if (patch.label !== undefined && !patch.label.trim()) throw invalid("label");
  if (patch.type !== undefined && !FIELD_TYPES.includes(patch.type)) throw invalid("type");
  if (patch.label !== undefined) field.label = patch.label.trim();
  if (patch.type !== undefined) field.type = patch.type;
}

// --- gli eventi recenti di una sorgente ---------------------------------------------------

/**
 * Gli eventi recenti di una sorgente (F4-5, F4-6: solo a chi gestisce le
 * integrazioni): nel prototipo gli eventi che hanno fatto partire le
 * esecuzioni delle automazioni che la usano, tutti accettati (il prototipo
 * non rifiuta niente: i rifiutati, col motivo, li dà il server).
 */
export async function listSourceEvents(id: string): Promise<AutomationSourceEvent[]> {
  const me = await gate("automations.listSourceEvents");
  if (!canManageIntegrations(me)) return [];
  return state.automationRuns
    .filter((r) => r.origin === "source" && canSeeRun(me, r))
    .filter((r) => {
      const a = state.automations.find((x) => x.id === r.automationId);
      const flow = a?.versions.find((v) => v.n === r.version)?.flow;
      return flow?.trigger.kind === "source" && flow.trigger.sourceId === id;
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((r) => ({
      id: r.id,
      receivedAt: r.startedAt,
      status: "accepted" as const,
      reason: null,
      payload: viewRun(me, r).event,
    }));
}

// --- «From recent events» ----------------------------------------------------------------

/** I clienti arrivati da eventi recenti che la tabella cliente → progetto non ha ancora. */
export async function listClientSuggestions(): Promise<
  { clientKey: string; clientName: string }[]
> {
  const me = await gate("automations.listClientSuggestions");
  if (!canManageIntegrations(me)) return [];
  const known = new Set(state.clientProjectLinks.map((l) => l.clientKey));
  const out = new Map<string, string>();
  // Solo gli eventi di esecuzioni che chi guarda vede (R-G5), e quelli d'esempio delle sorgenti.
  const events = [
    ...[...state.automationRuns]
      .filter((r) => canSeeRun(me, r))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((r) => viewRun(me, r).event),
    ...state.automationSources.flatMap((s) => s.sampleEvents),
  ];
  for (const e of events) {
    const c = e.cliente as { nome?: unknown; dominio?: unknown; email?: unknown } | undefined;
    if (typeof c?.nome !== "string") continue;
    const key = clientKeyOf(
      typeof c.dominio === "string"
        ? c.dominio
        : typeof c.email === "string"
          ? (c.email.split("@")[1] ?? "")
          : "",
    );
    if (!key || known.has(key) || out.has(key)) continue;
    out.set(key, c.nome);
  }
  return [...out].map(([clientKey, clientName]) => ({ clientKey, clientName }));
}
