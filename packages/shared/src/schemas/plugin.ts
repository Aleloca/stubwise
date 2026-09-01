import { z } from "zod";

/**
 * Schemi del REGISTRO PLUGIN d'istanza: repo git pubblici pinnati a uno sha,
 * materializzati dal worker su un volume e abilitabili per progetto.
 *
 * Stanno in `@stubwise/shared` perché il contratto ha tre lati: il worker
 * COSTRUISCE l'inventario leggendo la directory del plugin, il server lo salva
 * come jsonb e lo espone via API, la SPA lo disegna. Nessuno dei tre deve
 * ridichiarare la forma.
 */

// ---------------------------------------------------------------------------
// Stati (speculari alle colonne `text({enum})` di packages/db)
// ---------------------------------------------------------------------------

/**
 * Ciclo di vita della materializzazione: `none` (registrato, mai scaricato),
 * `materializing` (job in corso), `ready` (dir pronta, inventario disponibile),
 * `failed` (fetch/validate KO, motivo in `error`).
 */
export const pluginStatusSchema = z.enum(["none", "materializing", "ready", "failed"]);
export type PluginStatus = z.infer<typeof pluginStatusSchema>;

/**
 * Esito dello smoke run che verifica che le skill del plugin siano davvero
 * visibili al CLI. `idle` = mai eseguito (o resettato da un aggiornamento).
 */
export const pluginSmokeStatusSchema = z.enum(["idle", "pending", "passed", "failed"]);
export type PluginSmokeStatus = z.infer<typeof pluginSmokeStatusSchema>;

// ---------------------------------------------------------------------------
// Inventario (prodotto dal worker, persistito come jsonb, mostrato dalla UI)
// ---------------------------------------------------------------------------

/**
 * Una skill del plugin. `bytes` è la dimensione del suo `SKILL.md`: è il
 * "costo" che la UI mostra in KB — deliberatamente una misura oggettiva e non
 * una stima di token.
 */
export const pluginSkillSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  bytes: z.number().int().min(0),
});
export type PluginSkill = z.infer<typeof pluginSkillSchema>;

/** Un comando (`commands/*.md`) o un agente (`agents/*.md`) del plugin. */
const namedEntrySchema = z.object({ name: z.string().min(1).max(200) });

/**
 * Un gruppo di hook del plugin, appiattito: `hooks/hooks.json` ha la forma
 * `{hooks: {<Evento>: [{matcher?, hooks:[{command}]}]}}`, qui diventa una lista
 * piatta. `key` è `<Evento>#<indice>` (es. `SessionStart#0`) ed è la chiave con
 * cui un progetto può spegnere il singolo gruppo: NON è vincolata da un regex
 * perché la costruisce il worker dai nomi evento che trova nel file, e un
 * evento inatteso deve poter essere elencato (e spento), non far fallire il
 * parse dell'inventario. `command` è mostrato in chiaro in UI: un hook è codice
 * che gira, chi abilita il plugin deve poterlo leggere.
 */
export const pluginHookSchema = z.object({
  key: z.string().min(1).max(200),
  event: z.string().min(1).max(200),
  matcher: z.string().max(500).optional(),
  command: z.string().min(1).max(4000),
});
export type PluginHook = z.infer<typeof pluginHookSchema>;

/**
 * Inventario di un plugin materializzato: cosa contiene, come lo ha letto il
 * worker. `name`/`version`/`description` vengono da `.claude-plugin/plugin.json`
 * (solo `name` è garantito).
 *
 * `hasMcp` dice che il plugin porta un `.mcp.json`: Stubwise lo IGNORA per
 * costruzione (la copia per-run lo esclude, il canale MCP resta `--mcp-config`),
 * il booleano serve solo a dirlo in UI invece di nasconderlo.
 *
 * Le liste non hanno un tetto: l'inventario non arriva da un utente ma dal
 * worker, e viene riletto dal jsonb già salvato — un cap trasformerebbe un
 * plugin insolitamente grosso in una riga illeggibile.
 */
export const pluginInventorySchema = z.object({
  name: z.string().min(1).max(200),
  version: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  skills: z.array(pluginSkillSchema),
  commands: z.array(namedEntrySchema),
  agents: z.array(namedEntrySchema),
  hooks: z.array(pluginHookSchema),
  hasMcp: z.boolean(),
});
export type PluginInventory = z.infer<typeof pluginInventorySchema>;

// ---------------------------------------------------------------------------
// Proiezione pubblica
// ---------------------------------------------------------------------------

/**
 * Proiezione pubblica di un plugin del registro (API admin). Le date sono ISO
 * 8601; i campi valorizzati solo dopo una materializzazione riuscita
 * (`resolvedSha`, `inventory`, `materializedAt`) sono null finché non c'è.
 */
export const pluginSchema = z.object({
  id: z.uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  sourceUrl: z.url(),
  sourceSubdir: z.string().nullable(),
  ref: z.string().min(1),
  // Sha effettivamente in uso: il pin è sempre uno sha, mai un ref mobile.
  resolvedSha: z.string().nullable(),
  status: pluginStatusSchema,
  inventory: pluginInventorySchema.nullable(),
  error: z.string().nullable(),
  smokeStatus: pluginSmokeStatusSchema,
  smokeError: z.string().nullable(),
  materializedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Plugin = z.infer<typeof pluginSchema>;

// ---------------------------------------------------------------------------
// Input del registro (POST /api/plugins, POST /api/plugins/:id/update)
// ---------------------------------------------------------------------------

/**
 * URL sorgente del plugin. Solo `https://` pubblico: il fetch gira senza auth
 * (`GIT_TERMINAL_PROMPT=0`), quindi uno schema diverso non funzionerebbe
 * comunque, e le credenziali nell'URL (`https://utente:token@host/...`) sono
 * rifiutate qui perché finirebbero in chiaro nel DB e nei log.
 */
const pluginSourceUrlSchema = z
  .url()
  .max(2000)
  .refine((raw) => {
    // ⚠️ Il try/catch NON è ridondante: in Zod v4 un check di formato fallito
    // (`z.url()` su "non-un-url", "https://", "https://%") NON interrompe la
    // catena, e questo refine gira lo stesso sulla stringa grezza. Senza
    // cattura, `new URL` lancerebbe un TypeError FUORI da Zod: `safeParse`
    // smetterebbe di essere sicuro e la rotta di creazione risponderebbe 500
    // invece del 400 di validazione. Restituendo `false` l'errore resta un
    // ZodError, cioè un errore dell'utente.
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return false;
    }
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  }, "serve un URL https pubblico senza credenziali");

/**
 * Sottocartella del repo che contiene il plugin. Percorso relativo
 * normalizzato: niente slash iniziale/finale, niente `.`/`..` (fail-closed —
 * una subdir malformata è un errore, non un fetch della radice), perché la dir
 * risultante viene concatenata alla checkout e non deve poterne uscire.
 *
 * Il backslash è rifiutato del tutto: su Linux (dove gira il worker) è un
 * carattere di filename qualsiasi, quindi `a\..\b` non è traversal oggi — ma è
 * un segmento che `split("/")` non spezza, e nessun plugin reale ne ha bisogno.
 */
const pluginSourceSubdirSchema = z
  .string()
  .min(1)
  .max(500)
  // Un segmento vuoto copre anche slash iniziale/finale e doppio slash (a//b).
  .refine((p) => {
    if (p.includes("\\")) return false;
    const segments = p.split("/");
    return segments.every((s) => s !== "" && s !== "." && s !== "..");
  }, "path non normalizzato o traversal");

/** Registrazione di un plugin: sorgente, ref da pinnare, subdir opzionale. */
export const createPluginSchema = z.object({
  sourceUrl: pluginSourceUrlSchema,
  ref: z.string().min(1).max(200),
  sourceSubdir: pluginSourceSubdirSchema.optional(),
});
export type CreatePluginInput = z.infer<typeof createPluginSchema>;

/**
 * Aggiornamento di un plugin: si cambia solo il ref (sorgente e subdir sono
 * l'identità del plugin — per cambiarle si rimuove e si ri-aggiunge).
 */
export const updatePluginRefSchema = z.object({
  ref: z.string().min(1).max(200),
});
export type UpdatePluginRefInput = z.infer<typeof updatePluginRefSchema>;

// ---------------------------------------------------------------------------
// Abilitazioni per progetto (GET/PUT /api/projects/:id/plugins)
// ---------------------------------------------------------------------------

/**
 * Abilitazione di un plugin su un progetto, con gli spegnimenti a grana fine:
 * `disabledSkills` sono nomi di skill dell'inventario, `disabledHooks` sono
 * chiavi `<Evento>#<indice>`. Spegnere è per sottrazione (default: tutto
 * acceso) perché l'inventario può crescere con un aggiornamento del plugin.
 */
export const projectPluginSchema = z.object({
  pluginId: z.uuid(),
  enabled: z.boolean(),
  disabledSkills: z.array(z.string().min(1).max(200)).max(500).default([]),
  disabledHooks: z.array(z.string().min(1).max(200)).max(500).default([]),
});
export type ProjectPlugin = z.infer<typeof projectPluginSchema>;

/**
 * Body del PUT delle abilitazioni: l'INSIEME COMPLETO per il progetto (i plugin
 * assenti risultano non abilitati). `plugins` non ha default proprio per questo:
 * un body senza il campo è un errore, non un azzeramento silenzioso.
 *
 * Un `pluginId` ripetuto è rifiutato QUI: con la semantica di sostituzione
 * completa due voci sullo stesso plugin sono un body ambiguo (chi vince?), e
 * lasciarle passare significherebbe o un'ultima-scrive-vince silenziosa o una
 * violazione della unique `(project_id, plugin_id)` che l'utente vedrebbe come
 * 500 invece che come 400. I duplicati DENTRO `disabledSkills`/`disabledHooks`
 * restano innocui: spegnere è una sottrazione, ed è idempotente.
 */
export const putProjectPluginsSchema = z.object({
  plugins: z
    .array(projectPluginSchema)
    .max(200)
    .refine(
      (plugins) => new Set(plugins.map((p) => p.pluginId)).size === plugins.length,
      "pluginId duplicato nell'insieme delle abilitazioni",
    ),
});
export type PutProjectPluginsInput = z.infer<typeof putProjectPluginsSchema>;
