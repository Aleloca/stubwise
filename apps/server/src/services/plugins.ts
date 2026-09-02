/**
 * REGISTRO PLUGIN d'istanza (fase 3), lato server: registrazione, aggiornamento
 * a un ref, smoke, rimozione e abilitazioni per progetto.
 *
 * Il server NON monta il volume dei plugin: i file stanno su `PLUGINS_DIR`, che
 * è del worker. Qui si scrivono solo METADATI (`plugins`, `project_plugins`) e
 * si accodano job (`plugin_jobs`); tutto ciò che tocca il filesystem lo fa il
 * poller del worker. Di conseguenza ogni azione "fai qualcosa" è ASINCRONA e
 * risponde 202: la UI segue lo stato con il polling su `status`/`smokeStatus`.
 *
 * Le regole applicate qui (e non nelle rotte) sono quelle che non devono poter
 * divergere tra superfici: derivazione e validazione dello slug, mutua
 * esclusione dei job, plugin in uso, coerenza degli spegnimenti con
 * l'inventario.
 */
import {
  pluginJobs,
  plugins,
  projectPlugins,
  type Db,
  type PluginRow,
  type ProjectPluginRow,
} from "@stubwise/db";
import {
  pluginInventorySchema,
  pluginSlugSchema,
  type CreatePluginInput,
  type ProjectPlugin,
} from "@stubwise/shared";
import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import { isUniqueViolation } from "../routes/shared.js";

/** Lunghezza massima dello slug, la stessa del pattern in `@stubwise/shared`. */
const SLUG_MAX_LENGTH = 64;

// ---------------------------------------------------------------------------
// Slug
// ---------------------------------------------------------------------------

/**
 * Deriva lo slug del plugin dalla sua sorgente: ultimo segmento della
 * sottocartella se c'è (in un monorepo di plugin è quello che li distingue),
 * altrimenti ultimo segmento del path dell'URL. Restituisce `null` se non se ne
 * ricava uno slug valido.
 *
 * ⚠️ QUESTO È IL PUNTO IN CUI UNA STRINGA ARBITRARIA DIVENTA UN PEZZO DI PATH.
 * Il worker materializza in `<PLUGINS_DIR>/<slug>/<sha>/` e su quella directory
 * fa `rename` e `rm -rf`: uno slug come `..` o `a/b` non è un dettaglio
 * estetico. Perciò la normalizzazione è per SOTTRAZIONE (si tiene solo
 * `[a-z0-9-]`) e l'esito viene comunque riverificato contro
 * `pluginSlugSchema` — se non passa, si torna `null` e il chiamante rifiuta con
 * 400 invece di inventare uno slug storto.
 *
 * Il `null` non è un caso di errore raro: `https://github.com/` o una subdir
 * fatta di soli punti non contengono nessun nome, e forzarne uno (un uuid, un
 * "plugin-1") produrrebbe una dir che nessuno riconosce sul volume.
 */
export function derivePluginSlug(sourceUrl: string, sourceSubdir?: string | null): string | null {
  const raw = sourceSubdir ? lastSegment(sourceSubdir) : lastUrlSegment(sourceUrl);
  if (raw === null) return null;

  // Il segmento dell'URL arriva percent-encoded: si decodifica per ottenere lo
  // slug che un umano riconosce (`my%20plugin` → `my-plugin`). Un encoding
  // malformato non è un errore fatale — si prosegue sulla stringa grezza, che
  // la normalizzazione ripulisce comunque.
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* stringa grezza */
  }

  const slug = decoded
    .toLowerCase()
    // Convenzione dei remoti git: `superpowers.git` è il repo `superpowers`.
    .replace(/\.git$/, "")
    // Sottrazione: tutto ciò che non è `[a-z0-9]` diventa un separatore. Copre
    // in un colpo solo separatori di path, punti, spazi, metacaratteri di shell
    // e qualsiasi cosa non ASCII.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    // Il troncamento può cadere su un trattino: toglierlo qui, non lasciarlo.
    .replace(/-+$/, "");

  return pluginSlugSchema.safeParse(slug).success ? slug : null;
}

/** Ultimo segmento non vuoto di un path relativo; `null` se non ce n'è. */
function lastSegment(path: string): string | null {
  const segments = path.split(/[/\\]/).filter((s) => s !== "");
  return segments.at(-1) ?? null;
}

/** Ultimo segmento non vuoto del path di un URL; `null` se l'URL è illeggibile. */
function lastUrlSegment(sourceUrl: string): string | null {
  try {
    return lastSegment(new URL(sourceUrl).pathname);
  } catch {
    // `createPluginSchema` valida già l'URL, quindi qui non ci si arriva dalle
    // rotte: è la difesa per gli altri chiamanti (test, script).
    return null;
  }
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

/**
 * Elenco del registro in ordine di slug: è un elenco che si consulta per nome
 * (la UI ci cerca dentro un plugin), non un flusso cronologico.
 */
export async function listPlugins(db: Db): Promise<PluginRow[]> {
  return db.select().from(plugins).orderBy(asc(plugins.slug));
}

/** Una riga del registro, o `null`. */
export async function getPlugin(db: Db, id: string): Promise<PluginRow | null> {
  const [row] = await db.select().from(plugins).where(eq(plugins.id, id));
  return row ?? null;
}

export type CreatePluginResult =
  | { ok: true; plugin: PluginRow }
  /** L'URL (o la subdir) non contiene un nome da cui ricavare uno slug valido. */
  | { ok: false; error: "invalid_slug" }
  /** Esiste già un plugin con quello slug: l'admin deve rimuoverlo o cambiare sorgente. */
  | { ok: false; error: "slug_taken"; slug: string };

/**
 * Registra un plugin E accoda subito la sua materializzazione: un plugin
 * registrato e mai scaricato non serve a nessuno, e la UI si aspetta di vedere
 * `materializing` appena dopo l'aggiunta.
 *
 * `name` = slug: alla registrazione il nome vero del plugin non si conosce
 * ancora (sta in `.claude-plugin/plugin.json`, che il worker legge solo dopo il
 * fetch e mette in `inventory.name`). Duplicare qui un nome "bello" inventato
 * dall'URL creerebbe una seconda verità destinata a divergere da quella del
 * manifest.
 */
export async function createPlugin(db: Db, input: CreatePluginInput): Promise<CreatePluginResult> {
  const slug = derivePluginSlug(input.sourceUrl, input.sourceSubdir);
  if (slug === null) return { ok: false, error: "invalid_slug" };

  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(plugins)
        .values({
          slug,
          name: slug,
          sourceUrl: input.sourceUrl,
          ref: input.ref,
          sourceSubdir: input.sourceSubdir ?? null,
        })
        .returning();
      if (!created) throw new Error("insert del plugin non ha restituito la riga");
      await tx.insert(pluginJobs).values({ pluginId: created.id, kind: "materialize" });
      return { ok: true as const, plugin: created };
    });
  } catch (error) {
    // Unico unique in gioco su questa transazione: `plugins.slug` (il plugin è
    // appena nato, non può avere già un job attivo).
    if (isUniqueViolation(error)) return { ok: false, error: "slug_taken", slug };
    throw error;
  }
}

export type RequestUpdateResult =
  | { ok: true }
  | { ok: false; error: "not_found" }
  /** C'è già una materializzazione in coda o in corso su questo plugin. */
  | { ok: false; error: "job_in_flight" };

/**
 * Cambia il ref richiesto e accoda la materializzazione, nella STESSA
 * transazione: se il job non entra (materializzazione già in volo) il ref non
 * deve cambiare, altrimenti il registro direbbe "v2" mentre sul volume c'è
 * ancora ciò che il job in corso sta scrivendo per "v1".
 *
 * Il 409 arriva dalla violazione dell'indice unico parziale
 * `plugin_jobs_active_unique`, NON da una select preventiva: fra una select e
 * l'insert ci starebbe comodamente la richiesta di un altro admin.
 */
export async function requestUpdate(db: Db, id: string, ref: string): Promise<RequestUpdateResult> {
  try {
    return await db.transaction(async (tx) => {
      // `updatedAt` esplicito: la colonna non ha `$onUpdate` (scelta coerente
      // con `repo_graphs`), quindi ogni scrittura se lo porta dietro.
      const [updated] = await tx
        .update(plugins)
        .set({ ref, updatedAt: new Date() })
        .where(eq(plugins.id, id))
        .returning({ id: plugins.id });
      // Nessuna riga toccata: niente da annullare, si esce prima dell'insert.
      if (!updated) return { ok: false as const, error: "not_found" as const };
      await tx.insert(pluginJobs).values({ pluginId: id, kind: "materialize" });
      return { ok: true as const };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: "job_in_flight" };
    throw error;
  }
}

export type RequestSmokeResult =
  | { ok: true }
  | { ok: false; error: "not_found" }
  /** Mai materializzato: non c'è nessuno sha su cui far girare lo smoke. */
  | { ok: false; error: "not_ready" }
  | { ok: false; error: "job_in_flight" };

/**
 * Riaccoda lo smoke run. Rifiuta se il plugin non è `ready`: senza
 * `resolvedSha` il job fallirebbe con certezza sul worker (che compone
 * `<slug>/<sha>`), e un fallimento annunciato è meglio darlo subito all'admin.
 */
export async function requestSmoke(db: Db, id: string): Promise<RequestSmokeResult> {
  const plugin = await getPlugin(db, id);
  if (!plugin) return { ok: false, error: "not_found" };
  if (plugin.status !== "ready" || !plugin.resolvedSha) return { ok: false, error: "not_ready" };

  try {
    return await db.transaction(async (tx) => {
      // Prima il job (è lui che può violare l'unique), poi lo stato osservabile:
      // così non resta mai un `pending` senza nessuno che lo risolva.
      await tx.insert(pluginJobs).values({ pluginId: id, kind: "smoke" });
      await tx
        .update(plugins)
        .set({ smokeStatus: "pending", smokeError: null, updatedAt: new Date() })
        .where(eq(plugins.id, id));
      return { ok: true as const };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: "job_in_flight" };
    throw error;
  }
}

export type DeletePluginResult =
  | { ok: true }
  | { ok: false; error: "not_found" }
  /** Abilitato su almeno un progetto: va prima disabilitato di lì. */
  | { ok: false; error: "plugin_in_use" };

/**
 * Rimuove un plugin dal registro. `plugin_jobs` e `project_plugins` seguono in
 * cascata; la DIRECTORY sul volume la ripulisce lo sweep del worker (il server
 * non monta `PLUGINS_DIR`).
 *
 * Il "in uso" è nella `WHERE` della DELETE, non in una select prima: un
 * `NOT EXISTS` dentro lo statement rende impossibile la finestra in cui
 * qualcuno abilita il plugin fra il controllo e la rimozione. Se non cancella
 * nulla si guarda dopo il perché — a quel punto è solo per scegliere il
 * messaggio, non per decidere.
 */
export async function deletePlugin(db: Db, id: string): Promise<DeletePluginResult> {
  const deleted = await db
    .delete(plugins)
    .where(
      and(
        eq(plugins.id, id),
        sql`NOT EXISTS (SELECT 1 FROM ${projectPlugins} WHERE ${projectPlugins.pluginId} = ${plugins.id} AND ${projectPlugins.enabled})`,
      ),
    )
    .returning({ id: plugins.id });
  if (deleted.length > 0) return { ok: true };
  return (await getPlugin(db, id))
    ? { ok: false, error: "plugin_in_use" }
    : { ok: false, error: "not_found" };
}

// ---------------------------------------------------------------------------
// Abilitazioni per progetto
// ---------------------------------------------------------------------------

/** Proiezione pubblica di una riga di `project_plugins` (il round-trip del PUT). */
function toProjectPlugin(row: ProjectPluginRow): ProjectPlugin {
  return {
    pluginId: row.pluginId,
    enabled: row.enabled,
    disabledSkills: row.disabledSkills,
    disabledHooks: row.disabledHooks,
  };
}

/** Abilitazioni correnti del progetto. Un plugin assente = non abilitato. */
export async function getProjectPlugins(db: Db, projectId: string): Promise<ProjectPlugin[]> {
  const rows = await db
    .select()
    .from(projectPlugins)
    .where(eq(projectPlugins.projectId, projectId))
    .orderBy(asc(projectPlugins.pluginId));
  return rows.map(toProjectPlugin);
}

export type PutProjectPluginsResult =
  | { ok: true; plugins: ProjectPlugin[] }
  /** Un `pluginId` che non è nel registro. */
  | { ok: false; error: "unknown_plugin"; detail: string }
  /** Uno spegnimento che cita una skill assente dall'inventario del plugin. */
  | { ok: false; error: "unknown_plugin_skill"; detail: string }
  /** Uno spegnimento che cita un hook assente dall'inventario del plugin. */
  | { ok: false; error: "unknown_plugin_hook"; detail: string };

/**
 * Sostituisce l'INSIEME COMPLETO delle abilitazioni del progetto: i plugin non
 * citati risultano non abilitati (le loro righe spariscono).
 *
 * Prima si valida, poi si scrive. Gli spegnimenti devono citare voci che
 * esistono DAVVERO nell'inventario: senza questo controllo un refuso
 * (`using-git-worktree` invece di `...trees`) verrebbe salvato in silenzio e la
 * skill che l'admin credeva spenta girerebbe in ogni run. È l'errore che questa
 * fase non può permettersi di rendere invisibile — perciò 400, non tolleranza.
 *
 * Un plugin senza inventario (mai materializzato) può essere abilitato ma non
 * può avere spegnimenti: non c'è nulla contro cui verificarli.
 */
export async function putProjectPlugins(
  db: Db,
  projectId: string,
  desired: ProjectPlugin[],
): Promise<PutProjectPluginsResult> {
  const ids = desired.map((p) => p.pluginId);
  const registry = new Map<string, PluginRow>();
  if (ids.length > 0) {
    for (const row of await db.select().from(plugins)) registry.set(row.id, row);
  }

  for (const entry of desired) {
    const plugin = registry.get(entry.pluginId);
    if (!plugin) return { ok: false, error: "unknown_plugin", detail: entry.pluginId };

    // Lettura DIFENSIVA del jsonb: può venire da una versione precedente del
    // formato dell'inventario. Un inventario illeggibile vale come assente.
    const parsed = pluginInventorySchema.safeParse(plugin.inventory);
    const skillNames = new Set(parsed.success ? parsed.data.skills.map((s) => s.name) : []);
    const hookKeys = new Set(parsed.success ? parsed.data.hooks.map((h) => h.key) : []);

    for (const name of entry.disabledSkills) {
      if (!skillNames.has(name)) {
        return { ok: false, error: "unknown_plugin_skill", detail: `${plugin.slug}: ${name}` };
      }
    }
    for (const key of entry.disabledHooks) {
      if (!hookKeys.has(key)) {
        return { ok: false, error: "unknown_plugin_hook", detail: `${plugin.slug}: ${key}` };
      }
    }
  }

  const rows = await db.transaction(async (tx) => {
    // Semantica di sostituzione completa: ciò che non è nel body sparisce.
    await tx
      .delete(projectPlugins)
      .where(
        ids.length > 0
          ? and(eq(projectPlugins.projectId, projectId), notInArray(projectPlugins.pluginId, ids))
          : eq(projectPlugins.projectId, projectId),
      );

    for (const entry of desired) {
      await tx
        .insert(projectPlugins)
        .values({
          projectId,
          pluginId: entry.pluginId,
          enabled: entry.enabled,
          disabledSkills: entry.disabledSkills,
          disabledHooks: entry.disabledHooks,
        })
        .onConflictDoUpdate({
          target: [projectPlugins.projectId, projectPlugins.pluginId],
          set: {
            enabled: entry.enabled,
            disabledSkills: entry.disabledSkills,
            disabledHooks: entry.disabledHooks,
            // Esplicito: la colonna non ha `$onUpdate`.
            updatedAt: new Date(),
          },
        });
    }

    return tx
      .select()
      .from(projectPlugins)
      .where(eq(projectPlugins.projectId, projectId))
      .orderBy(asc(projectPlugins.pluginId));
  });

  return { ok: true, plugins: rows.map(toProjectPlugin) };
}
