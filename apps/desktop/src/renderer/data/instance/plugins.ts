import { recordChange } from "../changelog/index";
import { hashOf, seededRandom } from "../seed/servers/metrics";
import { gate, newId, now, onStoreReset, state, storeGeneration } from "../store";
import { forbidden, notFound, writer } from "../writer";
import { canI, nameOf, reauthRefusal, refuse } from "./common";
import type { RegisteredPlugin } from "./state";
import type { InstanceRefusal, InstanceResult } from "./types";

// Il registro dei plugin d'istanza (area 9b, Task 4; CLAUDE.md «Plugin e
// skill dell'agente»): repository git pubblici https, fissati a un commit,
// che Claude può usare quando lavora. Si leggono e si scrivono con
// `plugins.manage`.
//
// ⚠️ Registrare un plugin ne ESEGUE già il codice: subito dopo, il worker lo
// installa e fa lo smoke test con tutto acceso. Il consenso è quindi sulla
// registrazione: registrare e aggiornare a un ref chiedono la casella «Mi
// fido di questo repository e di questo commit» (`trusted: true`,
// confermata dal maintainer il 30 ott 2026) E la riconferma (+R). La
// casella è un input come gli altri: senza, `invalid: "not_trusted"`, prima
// della riconferma. Rifare lo smoke test e rimuovere non chiedono né l'una
// né l'altra: non eseguono codice nuovo.
//
// Il ciclo, simulato: `materializing` → dopo `PLUGIN_STEP_MS` `ready` (con
// sha, inventario e smoke `running`) o `failed` (con l'errore del worker,
// esito scelto nel riquadro «Prototype only», vale una volta); da `ready`,
// dopo un altro passo, smoke `passed`. Un ripristino dello stato
// (`resetApi`) ferma i timer: nessuna transizione arriva nello stato nuovo,
// come gli script delle conversazioni.

export const PLUGIN_STEP_MS = 800;

const MANAGE = "plugins.manage";
/** Lo slug è un pezzo di percorso sul volume del worker: lo stesso pattern di `@stubwise/shared`. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type PluginView = RegisteredPlugin & {
  registeredByName: string | null;
  /** Chi l'ha registrato o aggiornato per ultimo («updated … by»). */
  updatedByName: string | null;
  /**
   * Un passo del ciclo è in corso (preparazione o smoke test): la pagina
   * rilegge da sola, e aggiornare o rifare lo smoke aspettano.
   */
  busy: boolean;
};

const pluginOf = (id: string) => state.instance.plugins.find((p) => p.id === id);
const objectOf = (p: RegisteredPlugin) => ({ type: "plugin", id: p.id, label: p.name });

function viewOf(p: RegisteredPlugin): PluginView {
  return {
    ...structuredClone(p),
    registeredByName: nameOf(p.registeredById),
    updatedByName: nameOf(p.updatedById),
    busy: busy(p),
  };
}

function managed(
  me: string,
  id: string,
): { plugin: RegisteredPlugin } | { refusal: InstanceRefusal } {
  if (!canI(me, MANAGE)) return { refusal: refuse.forbidden() };
  const plugin = pluginOf(id);
  return plugin ? { plugin } : { refusal: refuse.notFound() };
}

/** Un passo del ciclo in corso: la transizione di preparazione o lo smoke test. */
const busy = (p: RegisteredPlugin) => p.status === "materializing" || p.smoke === "running";

// --- indirizzo e slug -------------------------------------------------------

/**
 * Il motivo per cui l'indirizzo non va, o `null`: `git_ssh` per un
 * `git@host:…`, `credentials` per nome utente o password nell'indirizzo (il
 * repository dev'essere pubblico: il worker lo scarica senza credenziali),
 * `https` per tutto ciò che non è un indirizzo https leggibile.
 */
function urlProblem(url: string): string | null {
  if (/^[\w.-]+@[\w.-]+:/.test(url)) return "git_ssh";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "https";
  }
  if (parsed.protocol !== "https:" || parsed.hostname === "") return "https";
  if (parsed.username !== "" || parsed.password !== "") return "credentials";
  return null;
}

/** L'ultimo segmento non vuoto di un percorso. */
const lastSegment = (path: string): string | null => path.split("/").filter(Boolean).at(-1) ?? null;

/**
 * Lo slug: l'ultimo segmento della sottocartella se c'è, altrimenti quello
 * dell'indirizzo, senza `.git`. Non si «aggiusta» (il web lo normalizza, il
 * prototipo lo mostra com'è nel rifiuto, shape «“My_Plugin”, which isn't
 * allowed»): `ok` dice se rispetta il pattern, `name` è com'è.
 */
function slugOf(url: string, subdir: string | null): { name: string; ok: boolean } {
  const raw = subdir ? lastSegment(subdir) : lastSegment(new URL(url).pathname);
  const name = raw?.replace(/\.git$/, "") ?? "";
  return { name, ok: SLUG_RE.test(name) };
}

/** L'indirizzo per riconoscere un doppione: senza maiuscole nell'host, `.git` e `/` finali. */
function sameSource(url: string): string {
  const u = new URL(url);
  return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, "").replace(/\.git$/, "")}`;
}

/** La sottocartella pulita: senza `/` ai bordi, `null` se vuota; `undefined` se esce dal repository. */
function cleanSubdir(subdir: string | null): string | null | undefined {
  const value = (subdir ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (value === "") return null;
  return value.split("/").some((s) => s === "..") ? undefined : value;
}

// --- il ciclo simulato --------------------------------------------------------

const timers = new Map<string, ReturnType<typeof setTimeout>>();

onStoreReset(() => {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
});

function cancel(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
}

/** Un passo, se lo stato è ancora quello di quando è partito e il plugin c'è ancora. */
function after(id: string, step: (p: RegisteredPlugin) => void): void {
  cancel(id);
  const generation = storeGeneration();
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      if (storeGeneration() !== generation) return;
      const p = pluginOf(id);
      if (p) step(p);
    }, PLUGIN_STEP_MS),
  );
}

/** Uno sha finto e stabile per indirizzo e ref (40 cifre esadecimali). */
function shaOf(url: string, ref: string): string {
  const rnd = seededRandom(hashOf(`${url}|${ref}`));
  return Array.from({ length: 40 }, () => Math.floor(rnd() * 16).toString(16)).join("");
}

/** L'inventario finto di un plugin preparato: due skill e un hook. */
function inventoryOf(): NonNullable<RegisteredPlugin["inventory"]> {
  return {
    skills: [
      { name: "getting-started", description: "Explains when to use this plugin's skills." },
      { name: "code-review", description: "Reviews a change against the project's conventions." },
    ],
    hooks: [
      {
        key: "SessionStart#0",
        event: "SessionStart",
        command: "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh",
      },
    ],
  };
}

/** Lo smoke test: superato dopo un passo. */
function smoke(p: RegisteredPlugin): void {
  p.smoke = "running";
  after(p.id, (q) => {
    if (q.status === "ready" && q.smoke === "running") q.smoke = "passed";
  });
}

/**
 * La preparazione: l'esito lo decide il riquadro «Prototype only» ADESSO,
 * alla scrittura, e vale una volta. Un fallimento lascia sha e inventario
 * del commit di prima (per un plugin nuovo, nessuno).
 */
function materialize(p: RegisteredPlugin): void {
  const outcome = state.instance.simulate.nextPluginOutcome;
  state.instance.simulate.nextPluginOutcome = "ready";
  p.status = "materializing";
  p.smoke = null;
  p.error = null;
  after(p.id, (q) => {
    if (q.status !== "materializing") return;
    if (outcome === "failed") {
      q.status = "failed";
      q.error = `plugin validate --strict failed at ${q.ref}: .claude-plugin/plugin.json not found.`;
      return;
    }
    q.status = "ready";
    q.sha = shaOf(q.url, q.ref);
    q.inventory = inventoryOf();
    smoke(q);
  });
}

// --- letture -------------------------------------------------------------------

/** I plugin del registro (il plugin base di Stubwise non c'è: è sempre acceso). */
export async function listPlugins(): Promise<PluginView[]> {
  const me = await gate("instance.listPlugins");
  if (!canI(me, MANAGE)) throw forbidden();
  return state.instance.plugins.map(viewOf);
}

/** Un plugin, con l'inventario intero. */
export async function getPlugin(id: string): Promise<PluginView> {
  const me = await gate("instance.getPlugin");
  if (!canI(me, MANAGE)) throw forbidden();
  const p = pluginOf(id);
  if (!p) throw notFound();
  return viewOf(p);
}

/** SOLO PROTOTIPO: come finirà la prossima registrazione o il prossimo aggiornamento (il riquadro lo rilegge). */
export async function getNextPluginOutcome(): Promise<"ready" | "failed"> {
  const me = await gate("instance.getNextPluginOutcome");
  if (!canI(me, MANAGE)) throw forbidden();
  return state.instance.simulate.nextPluginOutcome;
}

// --- scritture -------------------------------------------------------------------

/**
 * Registra un plugin (casella «Mi fido» e +R) e lo mette in preparazione.
 * `invalid`: `not_trusted`, l'indirizzo (`https`, `credentials`,
 * `git_ssh`), `ref`, `subdir`, `slug`, `duplicate` (lo stesso indirizzo e
 * la stessa sottocartella sono già registrati). Uno slug già preso da un
 * altro indirizzo è `conflict`: due plugin non stanno nella stessa
 * cartella.
 */
export async function registerPlugin(input: {
  url: string;
  ref: string;
  subdir: string | null;
  trusted: true;
}): Promise<InstanceResult<{ pluginId: string; name: string }>> {
  const me = await writer("instance.registerPlugin");
  if (!canI(me, MANAGE)) return refuse.forbidden();
  if (input.trusted !== true) return refuse.invalid("not_trusted");
  const url = input.url.trim();
  const problem = urlProblem(url);
  if (problem) return refuse.invalid(problem);
  const ref = input.ref.trim();
  if (!ref) return refuse.invalid("ref");
  const subdir = cleanSubdir(input.subdir);
  if (subdir === undefined) return refuse.invalid("subdir");
  const { name: slug, ok: slugOk } = slugOf(url, subdir);
  // Il nome com'è, perché la frase lo dica (vuoto: l'indirizzo non ne dà uno).
  if (!slugOk) return { ok: false, error: "invalid", reason: "slug", name: slug };
  const source = sameSource(url);
  const same = state.instance.plugins.find(
    (p) => sameSource(p.url) === source && p.subdir === subdir,
  );
  if (same) return { ok: false, error: "invalid", reason: "duplicate", name: same.name };
  if (state.instance.plugins.some((p) => p.slug === slug)) return refuse.conflict();
  const blocked = reauthRefusal(me, "instance.registerPlugin");
  if (blocked) return blocked;

  const plugin: RegisteredPlugin = {
    id: newId("plg"),
    slug,
    // Il nome vero viene dal manifest; nel prototipo è lo slug.
    name: slug,
    url,
    ref,
    sha: null,
    subdir,
    status: "materializing",
    smoke: null,
    error: null,
    inventory: null,
    registeredById: me,
    updatedById: me,
    updatedAt: now(),
  };
  state.instance.plugins.push(plugin);
  recordChange({
    kind: "plugin.registered",
    actorId: me,
    projectId: null,
    object: objectOf(plugin),
    params: { ref },
  });
  materialize(plugin);
  return { ok: true, pluginId: plugin.id, name: plugin.name };
}

/**
 * Aggiorna a un altro ref (casella «Mi fido» e +R): esegue il codice del
 * commit nuovo come la registrazione. Durante un passo del ciclo è
 * `conflict`. La voce ha il ref di prima e di dopo.
 */
export async function updatePluginRef(
  id: string,
  input: { ref: string; trusted: true },
): Promise<InstanceResult> {
  const me = await writer("instance.updatePluginRef");
  const found = managed(me, id);
  if ("refusal" in found) return found.refusal;
  if (input.trusted !== true) return refuse.invalid("not_trusted");
  const ref = input.ref.trim();
  if (!ref) return refuse.invalid("ref");
  const { plugin } = found;
  if (busy(plugin)) return refuse.conflict();
  const blocked = reauthRefusal(me, "instance.updatePluginRef");
  if (blocked) return blocked;

  const before = plugin.ref;
  plugin.ref = ref;
  plugin.updatedAt = now();
  plugin.updatedById = me;
  recordChange({
    kind: "plugin.ref_updated",
    actorId: me,
    projectId: null,
    object: objectOf(plugin),
    before,
    after: ref,
  });
  materialize(plugin);
  return { ok: true };
}

/** Rifà lo smoke test sullo stesso commit, già accettato: niente casella né riconferma. */
export async function rerunSmoke(id: string): Promise<InstanceResult> {
  const me = await writer("instance.rerunSmoke");
  const found = managed(me, id);
  if ("refusal" in found) return found.refusal;
  const { plugin } = found;
  if (plugin.status !== "ready") return refuse.invalid("not_ready");
  if (busy(plugin)) return refuse.conflict();
  recordChange({
    kind: "plugin.smoke_rerun",
    actorId: me,
    projectId: null,
    object: objectOf(plugin),
  });
  smoke(plugin);
  return { ok: true };
}

/** Rimuove un plugin: i progetti ne perdono skill e hook dalla prossima esecuzione. Ferma il suo ciclo. */
export async function removePlugin(id: string): Promise<InstanceResult> {
  const me = await writer("instance.removePlugin");
  const found = managed(me, id);
  if ("refusal" in found) return found.refusal;
  cancel(id);
  state.instance.plugins = state.instance.plugins.filter((p) => p.id !== id);
  recordChange({
    kind: "plugin.removed",
    actorId: me,
    projectId: null,
    object: objectOf(found.plugin),
  });
  return { ok: true };
}

/** SOLO PROTOTIPO (riquadro «Prototype only»): come finisce la prossima registrazione o il prossimo aggiornamento. */
export async function simulateNextPluginOutcome(
  outcome: "ready" | "failed",
): Promise<InstanceResult> {
  const me = await writer("instance.simulateNextPluginOutcome");
  if (!canI(me, MANAGE)) return refuse.forbidden();
  if (outcome !== "ready" && outcome !== "failed") return refuse.invalid("outcome");
  state.instance.simulate.nextPluginOutcome = outcome;
  return { ok: true };
}
