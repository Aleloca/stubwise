import { createHash, randomBytes } from "node:crypto";
import { automationRuns, automations, automationSourceEvents, automationSources, automationVersions, clientProjectLinks, projects, type Db } from "@stubwise/db";
import {
  clientKeyOf,
  deriveFields,
  fieldKeys,
  hasForbiddenKey,
  mergeFields,
  visitSteps,
  type AutomationFlow,
  type AutomationSourceEvent,
  type AutomationSourceView,
  type ClientLinkView,
  type ClientSuggestion,
  type DataField,
  type FieldType,
  type WebhookExamplePreview,
  type WebhookSourceCreated,
} from "@stubwise/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { projectIdsWithPermission } from "../auth/access.js";
import { AutomationError, managesGeneral, notFound, seen, sees, seesAutomation, sourceShape, type Viewer } from "./model.js";

/**
 * LE SORGENTI E LA TABELLA CLIENTE → PROGETTO (area 7, F4, S4; la specifica è
 * `data/automations/{webhooks,sourceWrites,reads}.ts` del prototipo).
 *
 * - Scrivere (creare un webhook, rinominarlo, rigenerarne l'indirizzo,
 *   l'esempio e i campi, la tabella) vuole `integrations.manage` d'istanza:
 *   lo dichiarano le rotte (`config.access`) e lo ricontrolla il servizio.
 * - Leggere sorgenti e tabella: chi può costruire un'automazione che le usa
 *   (`integrations.manage`, le generali, o `automations.manage` in un
 *   progetto), come `canSeeSources` del prototipo. Gli EVENTI RECENTI (i corpi
 *   arrivati, che possono avere dati di clienti) solo `integrations.manage`
 *   (F4-6 = a).
 * - Il SEGRETO dell'indirizzo è casuale (32 byte) e si salva come sha256:
 *   l'indirizzo intero esce solo dalla creazione e dalla rigenerazione, e
 *   rigenerare invalida subito il vecchio (l'hash cambia nella stessa riga).
 * - Un progetto della tabella che chi legge non vede resta senza id (R-G5).
 */

const INTEGRATIONS = "integrations.manage";
const forbiddenIntegrations = () => new AutomationError(403, "forbidden", "You need integrations.manage");
const badInput = (code: string, message: string) => new AutomationError(400, code, message);

export const canManageIntegrations = (viewer: Viewer) => viewer.instancePermissions.has(INTEGRATIONS);

/** Chi può leggere sorgenti e tabella: chi gestisce le integrazioni o può costruire un'automazione. */
export async function canSeeSources(db: Db, viewer: Viewer): Promise<boolean> {
  if (canManageIntegrations(viewer) || managesGeneral(viewer)) return true;
  const where = await projectIdsWithPermission(db, viewer, "automations.manage");
  return where === "all" || where.length > 0;
}

/** Il segreto di un indirizzo: `whk_` + 32 byte casuali (base64url); si salva solo l'hash. */
export const newWebhookSecret = () => `whk_${randomBytes(32).toString("base64url")}`;
export const hashWebhookSecret = (secret: string) => createHash("sha256").update(secret, "utf8").digest("hex");

/** L'indirizzo pubblico: `${PUBLIC_URL}/webhooks/in/<segreto>` (relativo se l'istanza non ha `PUBLIC_URL`). */
export function webhookAddress(publicUrl: string | null, secret: string): string {
  return `${publicUrl ?? ""}/webhooks/in/${secret}`;
}

type SourceRow = typeof automationSources.$inferSelect;

/** L'automazione (accesa o in pausa) che parte da ciascuna sorgente, con la sua ultima versione pubblicata. */
async function usersOf(db: Db, sourceIds: string[]) {
  if (sourceIds.length === 0) return new Map<string, typeof automations.$inferSelect>();
  const rows = await db
    .select({ automation: automations, sourceId: sql<string>`${automationVersions.flow}->'trigger'->>'sourceId'` })
    .from(automations)
    .innerJoin(automationVersions, eq(automationVersions.automationId, automations.id))
    .where(
      and(
        inArray(automations.status, ["active", "paused"]),
        sql`${automationVersions.publishedAt} is not null`,
        sql`${automationVersions.flow}->'trigger'->>'kind' = 'source'`,
        sql`${automationVersions.flow}->'trigger'->>'sourceId' in (${sql.join(sourceIds.map((id) => sql`${id}`), sql`, `)})`,
        sql`${automationVersions.n} = (select max(v2.n) from automation_versions v2 where v2.automation_id = ${automations.id} and v2.published_at is not null)`,
      ),
    );
  return new Map(rows.map((r) => [r.sourceId, r.automation]));
}

async function viewsOf(db: Db, viewer: Viewer, rows: SourceRow[]): Promise<AutomationSourceView[]> {
  const manage = canManageIntegrations(viewer);
  const used = await usersOf(db, rows.map((r) => r.id));
  const visible = await seen(db, viewer);
  return rows.map((row) => {
    const a = used.get(row.id);
    const shown = a && seesAutomation(visible, viewer, a);
    return { ...sourceShape(row), permissions: { manage }, usedBy: shown ? { code: a.code, name: a.name } : null, usedByHidden: !!a && !shown };
  });
}

export async function listSources(db: Db, viewer: Viewer): Promise<AutomationSourceView[]> {
  if (!(await canSeeSources(db, viewer))) return [];
  const rows = await db.select().from(automationSources).orderBy(sql`lower(${automationSources.name})`, automationSources.createdAt);
  return viewsOf(db, viewer, rows);
}

async function managedSource(db: Db, viewer: Viewer, id: string): Promise<SourceRow> {
  if (!canManageIntegrations(viewer)) throw forbiddenIntegrations();
  const [row] = await db.select().from(automationSources).where(eq(automationSources.id, id));
  if (!row) throw notFound();
  return row;
}

/** «Ordini e-shop»: un webhook nuovo, senza esempio né campi; l'indirizzo esce solo qui. */
export async function createWebhookSource(db: Db, viewer: Viewer, publicUrl: string | null, input: { name: string }): Promise<WebhookSourceCreated> {
  if (!canManageIntegrations(viewer)) throw forbiddenIntegrations();
  const name = input.name.trim();
  if (!name) throw badInput("name", "A name is required");
  const secret = newWebhookSecret();
  const [row] = await db.insert(automationSources).values({ kind: "webhook", name, secretHash: hashWebhookSecret(secret), createdBy: viewer.id }).returning();
  const [view] = await viewsOf(db, viewer, [row!]);
  return { source: view!, address: webhookAddress(publicUrl, secret) };
}

export async function renameSource(db: Db, viewer: Viewer, id: string, input: { name: string }): Promise<AutomationSourceView> {
  await managedSource(db, viewer, id);
  const name = input.name.trim();
  if (!name) throw badInput("name", "A name is required");
  const [row] = await db.update(automationSources).set({ name }).where(eq(automationSources.id, id)).returning();
  return (await viewsOf(db, viewer, [row!]))[0]!;
}

/** «Generate a new address»: il vecchio smette SUBITO di funzionare (l'hash cambia); il nuovo esce solo qui. */
export async function regenerateWebhook(db: Db, viewer: Viewer, publicUrl: string | null, id: string): Promise<WebhookSourceCreated> {
  await managedSource(db, viewer, id);
  const secret = newWebhookSecret();
  const [row] = await db
    .update(automationSources)
    .set({ secretHash: hashWebhookSecret(secret), regeneratedBy: viewer.id, regeneratedAt: sql`now()` })
    .where(eq(automationSources.id, id))
    .returning();
  return { source: (await viewsOf(db, viewer, [row!]))[0]!, address: webhookAddress(publicUrl, secret) };
}

// --- l'esempio e i campi --------------------------------------------------------------

/** Il tetto di un esempio incollato: lo stesso del corpo di un evento (F4-3 = a). */
export const EXAMPLE_MAX_BYTES = 256 * 1024;

function parseExample(json: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (Buffer.byteLength(json, "utf8") > EXAMPLE_MAX_BYTES) return { ok: false, error: "too_large" };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "object" };
  // Review F4, I2: `__proto__`, `constructor`, `prototype` non diventano mai campi.
  if (hasForbiddenKey(value)) return { ok: false, error: "forbidden_key" };
  return { ok: true, value: value as Record<string, unknown> };
}

/** `prodotti.nome` → `["prodotti", "nome"]` se `prodotti` è un elenco; altrimenti `[null, key]`. */
function splitListKey(fields: DataField[], key: string): [string | null, string] {
  const parent = fields.find((f) => f.type === "list" && key.startsWith(`${f.key}.`));
  return parent ? [parent.key, key.slice(parent.key.length + 1)] : [null, key];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cites = (text: string, key: string) => new RegExp(`\\{\\{\\s*${escapeRe(key)}\\s*\\}\\}|"${escapeRe(key)}"`).test(text);

/**
 * Le automazioni che chi guarda vede (R-G5) e che citano un campo nella
 * versione pubblicata o nella bozza (la regola di `usedBy` del prototipo).
 */
async function usedBy(db: Db, viewer: Viewer, source: SourceRow, key: string): Promise<string[]> {
  const [listKey, childKey] = splitListKey((source.fields ?? []) as DataField[], key);
  const rows = await db
    .select({ automation: automations, flow: automationVersions.flow, n: automationVersions.n })
    .from(automations)
    .innerJoin(automationVersions, eq(automationVersions.automationId, automations.id))
    .where(and(sql`${automationVersions.flow}->'trigger'->>'kind' = 'source'`, sql`${automationVersions.flow}->'trigger'->>'sourceId' = ${source.id}`));
  const visible = await seen(db, viewer);
  const out = new Set<string>();
  for (const { automation: a, flow } of rows) {
    if (!seesAutomation(visible, viewer, a)) continue;
    const f = flow as AutomationFlow;
    const text = JSON.stringify(f.steps);
    let hit = false;
    if (listKey === null) hit = cites(text, key);
    else
      visitSteps(f.steps, (s) => {
        if (s.kind === "forEach" && s.list === listKey && cites(text, `${s.as}.${childKey}`)) hit = true;
      });
    if (hit) out.add(a.code);
  }
  return [...out];
}

/** «Replace example», prima di confermare: i campi che ne derivano e quelli usati che spariscono. */
export async function previewWebhookExample(db: Db, viewer: Viewer, id: string, json: string): Promise<WebhookExamplePreview> {
  const source = await managedSource(db, viewer, id);
  const parsed = parseExample(json);
  if (!parsed.ok) return { error: parsed.error, fields: [], missing: [] };
  const old = (source.fields ?? []) as DataField[];
  const fields = mergeFields(deriveFields(parsed.value), old);
  const kept = new Set(fieldKeys(fields));
  const missing: WebhookExamplePreview["missing"] = [];
  for (const k of fieldKeys(old).filter((k) => !kept.has(k))) {
    const by = await usedBy(db, viewer, source, k);
    if (by.length > 0) missing.push({ key: k, label: old.find((f) => f.key === k)?.label ?? k, usedBy: by });
  }
  return { error: null, fields, missing };
}

/** Conferma l'esempio: ne derivano i campi (etichetta e tipo scelti a mano restano). */
export async function setWebhookExample(db: Db, viewer: Viewer, id: string, json: string): Promise<AutomationSourceView> {
  const source = await managedSource(db, viewer, id);
  const parsed = parseExample(json);
  if (!parsed.ok) throw badInput("json", parsed.error);
  const fields = mergeFields(deriveFields(parsed.value), (source.fields ?? []) as DataField[]);
  const [row] = await db.update(automationSources).set({ example: parsed.value, fields }).where(eq(automationSources.id, id)).returning();
  return (await viewsOf(db, viewer, [row!]))[0]!;
}

const FIELD_TYPES: readonly FieldType[] = ["text", "number", "date", "email", "person", "list", "file", "boolean"];

/** L'etichetta e il tipo di un campo (anche di uno dentro un elenco: `prodotti.nome`). */
export async function updateWebhookField(db: Db, viewer: Viewer, id: string, key: string, patch: { label?: string; type?: FieldType }): Promise<AutomationSourceView> {
  const source = await managedSource(db, viewer, id);
  const fields = structuredClone((source.fields ?? []) as DataField[]);
  const find = (list: DataField[], rest: string): DataField | undefined => {
    const direct = list.find((f) => f.key === rest);
    if (direct) return direct;
    const parent = list.find((f) => f.of && rest.startsWith(`${f.key}.`));
    return parent ? find(parent.of!, rest.slice(parent.key.length + 1)) : undefined;
  };
  const field = find(fields, key);
  if (!field) throw notFound();
  if (patch.label !== undefined && !patch.label.trim()) throw badInput("label", "A label is required");
  if (patch.type !== undefined && !FIELD_TYPES.includes(patch.type)) throw badInput("type", "Unknown type");
  if (patch.label !== undefined) field.label = patch.label.trim();
  if (patch.type !== undefined) field.type = patch.type;
  const [row] = await db.update(automationSources).set({ fields }).where(eq(automationSources.id, id)).returning();
  return (await viewsOf(db, viewer, [row!]))[0]!;
}

/** Gli eventi recenti (F4-5, F4-6): solo a chi ha `integrations.manage`, dal più nuovo. */
export async function listSourceEvents(db: Db, viewer: Viewer, id: string): Promise<AutomationSourceEvent[]> {
  await managedSource(db, viewer, id);
  const rows = await db.select().from(automationSourceEvents).where(eq(automationSourceEvents.sourceId, id)).orderBy(desc(automationSourceEvents.receivedAt)).limit(100);
  return rows.map((r) => ({ id: r.id, receivedAt: r.receivedAt.toISOString(), status: r.status, reason: r.reason, payload: r.payload ?? null }));
}

// --- la tabella cliente → progetto ----------------------------------------------------

export async function listClientLinks(db: Db, viewer: Viewer): Promise<ClientLinkView[]> {
  if (!(await canSeeSources(db, viewer))) return [];
  const visible = await seen(db, viewer);
  const rows = await db.select().from(clientProjectLinks).orderBy(clientProjectLinks.clientKey);
  return rows.map((l) => {
    const projectVisible = sees(visible, l.projectId);
    // Un progetto che chi legge non vede resta senza id (R-G5): la riga dice solo «un progetto».
    return {
      clientKey: l.clientKey,
      clientName: l.clientName,
      projectId: projectVisible ? l.projectId : "",
      projectVisible,
      ...(l.addedBy ? { addedById: l.addedBy } : {}),
      addedAt: l.addedAt.toISOString(),
    };
  });
}

/**
 * Aggiunge o cambia una riga (verso un progetto che chi agisce vede): una
 * nuova porta chi e quando, una cambiata li conserva. La chiave è
 * `clientKeyOf` (trim + lower), la stessa della ricerca.
 */
export async function putClientLink(db: Db, viewer: Viewer, rawKey: string, input: { clientName: string; projectId: string }): Promise<ClientLinkView> {
  if (!canManageIntegrations(viewer)) throw forbiddenIntegrations();
  return writeClientLink(db, viewer, rawKey, input);
}

/** La scrittura della riga, senza il controllo del permesso (lo fa chi chiama: la rotta, o «Remember for <client>»). */
export async function writeClientLink(db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0], viewer: Viewer, rawKey: string, input: { clientName: string; projectId: string }): Promise<ClientLinkView> {
  const clientKey = clientKeyOf(rawKey);
  const clientName = input.clientName.trim();
  if (!clientKey || clientKey.length > 200 || !clientName) throw badInput("client", "Client key and name are required");
  const visible = await seen(db as Db, viewer);
  const [project] = await (db as Db).select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId));
  if (!project || !sees(visible, input.projectId)) throw notFound();
  // Review F4 *(O, 46)*: una riga che punta a un progetto che chi scrive NON vede non si tocca (né si
  // reindirizza): risponde 404, come se non esistesse.
  const [existing] = await (db as Db).select({ projectId: clientProjectLinks.projectId }).from(clientProjectLinks).where(eq(clientProjectLinks.clientKey, clientKey));
  if (existing && !sees(visible, existing.projectId)) throw notFound();
  const [row] = await (db as Db)
    .insert(clientProjectLinks)
    .values({ clientKey, clientName, projectId: input.projectId, addedBy: viewer.id })
    .onConflictDoUpdate({ target: clientProjectLinks.clientKey, set: { clientName, projectId: input.projectId } })
    .returning();
  return { clientKey: row!.clientKey, clientName: row!.clientName, projectId: row!.projectId, projectVisible: true, ...(row!.addedBy ? { addedById: row!.addedBy } : {}), addedAt: row!.addedAt.toISOString() };
}

export async function removeClientLink(db: Db, viewer: Viewer, rawKey: string): Promise<void> {
  if (!canManageIntegrations(viewer)) throw forbiddenIntegrations();
  const key = clientKeyOf(rawKey);
  const [existing] = await db.select({ projectId: clientProjectLinks.projectId }).from(clientProjectLinks).where(eq(clientProjectLinks.clientKey, key));
  // Review F4 *(O, 46)*: una riga verso un progetto che chi la toglie non vede risponde 404, come se non esistesse.
  if (!existing || !sees(await seen(db, viewer), existing.projectId)) throw notFound();
  await db.delete(clientProjectLinks).where(eq(clientProjectLinks.clientKey, key));
}

/**
 * «From recent events»: i clienti delle esecuzioni ferme su «scegli il
 * progetto» (la `clientKey` del loro `pending`) che la tabella non ha ancora,
 * dalle esecuzioni che chi guarda VEDE (R-G5). Nel vero il cliente è il campo
 * che il passo indica (`clientRef`), non una forma `cliente.*` fissa.
 */
export async function listClientSuggestions(db: Db, viewer: Viewer): Promise<ClientSuggestion[]> {
  if (!canManageIntegrations(viewer)) return [];
  const rows = await db
    .select({ automation: automations, pending: automationRuns.pending })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(and(eq(automationRuns.status, "waiting_project"), sql`${automationRuns.pending}->'preview'->>'clientKey' is not null`))
    .orderBy(desc(automationRuns.startedAt))
    .limit(200);
  const known = new Set((await db.select({ k: clientProjectLinks.clientKey }).from(clientProjectLinks)).map((r) => r.k));
  const visible = await seen(db, viewer);
  const out = new Map<string, string>();
  for (const { automation: a, pending } of rows) {
    if (!seesAutomation(visible, viewer, a)) continue;
    const preview = ((pending ?? {}) as { preview?: { clientKey?: unknown; clientName?: unknown } }).preview ?? {};
    const key = clientKeyOf(preview.clientKey);
    if (!key || known.has(key) || out.has(key)) continue;
    out.set(key, typeof preview.clientName === "string" && preview.clientName.trim() ? preview.clientName.trim() : key);
  }
  return [...out].map(([clientKey, clientName]) => ({ clientKey, clientName }));
}
