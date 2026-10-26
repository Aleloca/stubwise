import { copy, gate, now, state } from "../store";
import type { AutomationSource, DataField, FieldType } from "../types";
import { forbidden, invalid, notFound, writer } from "../writer";
import { canManageIntegrations } from "./visibility";

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

/** `customer.email` → «Customer email»; `importoTotale` → «Importo totale». */
export function labelFromKey(key: string): string {
  const words = key
    .split(/[._-]+/)
    .flatMap((w) => w.replace(/([a-z])([A-Z])/g, "$1 $2").split(" "))
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

function typeOf(v: unknown): FieldType {
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (Array.isArray(v)) return "list";
  if (typeof v === "string" && EMAIL.test(v)) return "email";
  if (typeof v === "string" && DATE.test(v)) return "date";
  return "text";
}

/** I campi di un esempio: gli oggetti si appiattiscono (`cliente.nome`), gli elenchi di oggetti portano i loro. */
export function deriveFields(obj: Record<string, unknown>, prefix = ""): DataField[] {
  const out: DataField[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(...deriveFields(v as Record<string, unknown>, key));
    } else if (Array.isArray(v)) {
      const first = v[0];
      out.push({
        key,
        label: labelFromKey(key),
        type: "list",
        ...(first && typeof first === "object" && !Array.isArray(first)
          ? { of: deriveFields(first as Record<string, unknown>) }
          : {}),
      });
    } else out.push({ key, label: labelFromKey(key), type: typeOf(v) });
  }
  return out;
}

/** Le chiavi (anche quelle dentro gli elenchi, `prodotti.nome`) di un insieme di campi. */
function keysOf(fields: DataField[], prefix = ""): string[] {
  return fields.flatMap((f) => [
    prefix + f.key,
    ...(f.of ? keysOf(f.of, `${prefix}${f.key}.`) : []),
  ]);
}

/** Tiene etichetta e tipo scelti a mano per le chiavi che restano. */
function mergeFields(next: DataField[], old: DataField[]): DataField[] {
  return next.map((f) => {
    const was = old.find((o) => o.key === f.key);
    if (!was) return f;
    return {
      ...f,
      label: was.label,
      type: was.type,
      ...(f.of ? { of: mergeFields(f.of, was.of ?? []) } : {}),
    };
  });
}

/** Un campo è usato da un'automazione se il flusso lo cita (testi, condizioni, ingressi). */
function usedBy(source: AutomationSource, key: string): string[] {
  const re = new RegExp(
    `\\{\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}|"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
  );
  return state.automations
    .filter((a) =>
      a.versions.some(
        (v) =>
          v.flow.trigger.kind === "source" &&
          v.flow.trigger.sourceId === source.id &&
          re.test(JSON.stringify(v.flow.steps)),
      ),
    )
    .map((a) => a.code);
}

export interface WebhookExamplePreview {
  /** Il JSON non è valido: il messaggio del parser (riga e colonna, se le dice). */
  error: string | null;
  fields: DataField[];
  /** I campi di oggi che il nuovo esempio non ha e che un'automazione usa ([A 8]). */
  missing: { key: string; label: string; usedBy: string[] }[];
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

function preview(source: AutomationSource, json: string): WebhookExamplePreview {
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
  const kept = new Set(keysOf(fields));
  const missing = keysOf(source.fields)
    .filter((k) => !kept.has(k))
    .map((k) => ({
      key: k,
      label: source.fields.find((f) => f.key === k)?.label ?? k,
      usedBy: usedBy(source, k),
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
  return preview(webhook(me, id), json);
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

// --- «From recent events» ----------------------------------------------------------------

/** I clienti arrivati da eventi recenti che la tabella cliente → progetto non ha ancora. */
export async function listClientSuggestions(): Promise<
  { clientKey: string; clientName: string }[]
> {
  const me = await gate("automations.listClientSuggestions");
  if (!canManageIntegrations(me)) return [];
  const known = new Set(state.clientProjectLinks.map((l) => l.clientKey));
  const out = new Map<string, string>();
  const events = [
    ...[...state.automationRuns]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((r) => r.event),
    ...state.automationSources.flatMap((s) => s.sampleEvents),
  ];
  for (const e of events) {
    const c = e.cliente as { nome?: unknown; dominio?: unknown; email?: unknown } | undefined;
    if (typeof c?.nome !== "string") continue;
    const key =
      typeof c.dominio === "string"
        ? c.dominio
        : typeof c.email === "string"
          ? (c.email.split("@")[1] ?? "")
          : "";
    if (!key || known.has(key) || out.has(key)) continue;
    out.set(key, c.nome);
  }
  return [...out].map(([clientKey, clientName]) => ({ clientKey, clientName }));
}
