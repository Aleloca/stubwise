import { DEFAULT_THRESHOLDS } from "../seed/servers/servers";
import { changedFields } from "../changelog/settingValues";
import { copy, newId, now, state } from "../store";
import type { MonitoredServer, ServerCheck, ServerThresholds } from "../types";
import { forbidden, invalid, writer } from "../writer";
import { requireReauth } from "../auth/reauth";
import { environmentFor } from "../releases/visibility";
import { dropSshAccess } from "./access";
import { recordServerChange } from "./changes";
import {
  canMonitor,
  checkFor,
  checkView,
  holds,
  serverFor,
  serverRow,
  type ServerRow,
} from "./visibility";
import { hasMaskedCredentials, hasUrlCredentials, maskUrlCredentials } from "./urlCredentials";

// Il monitor dei server (area 8b), come la sezione Monitor del web: server,
// chiave dell'agente, soglie, controlli e progetto principale, tutto sotto
// `monitor.manage` (d'istanza). Gli errori: `not_found` per ciò che chi
// agisce non vede (R-G5), `forbidden` per ciò che vede ma non può fare,
// `invalid: <campo>` per un input sbagliato — controllato tutto PRIMA di
// scrivere, così uno scarto lascia il server com'era. I limiti sono quelli
// degli schemi del web (`packages/shared/src/schemas/server.ts`).
//
// La chiave dell'agente (`sk_…`) esce SOLO dal risultato di `createServer`
// e di `regenerateAgentKey`: non si conserva nello stato (sul web se ne
// tiene l'hash), quindi nessuna lettura può restituirla.

const NAME_MAX = 255;
const CHECK_NAME_MAX = 200;
const CHECK_TYPES: readonly ServerCheck["type"][] = ["http", "tcp", "process", "postgres", "mysql"];

const isInt = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;

/** Un nome valido (spazi tolti), o `invalid: name`. */
function nameOf(raw: unknown, max: number): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > max) throw invalid("name");
  return name;
}

/** Una chiave finta ma della forma vera: `sk_` e 40 esadecimali, diversa a ogni chiamata. */
function newAgentKey(code: string): string {
  const salt = `agent-key:${code}:${++state.counter}`;
  let out = "";
  for (let k = 0; out.length < 40; k++) {
    let h = 0x811c9dc5 ^ k;
    for (const ch of salt) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return `sk_${out.slice(0, 40)}`;
}

/** Il server su cui scrivere: visibile (o `not_found`) e con `monitor.manage` (o `forbidden`). */
function managed(me: string, code: string): MonitoredServer {
  const server = serverFor(me, code);
  if (!canMonitor(me)) throw forbidden();
  return server;
}

// --- server -----------------------------------------------------------------

export interface CreateServerInput {
  name: string;
  /**
   * L'ambiente in cui nasce: uno del progetto da cui lo si crea, senza un
   * server per tutto il progetto. `null` solo da Amministrazione (area 9b),
   * con `monitor.manage`: il server nasce ORFANO, senza progetto — da lì
   * nasce sempre così (decisione del maintainer, 30 ott 2026), e lo si
   * collega a un progetto dagli ambienti del progetto.
   */
  environmentId: string | null;
}

/**
 * Un server nuovo. Dalla sezione di un progetto nasce dentro un suo
 * ambiente (scelta del piano: serve anche `environments.manage` lì): entra
 * come riga per tutto il progetto (`repositoryId: null`, R-L2), l'ambiente
 * non deve averne già una. Da Amministrazione (`environmentId: null`) nasce
 * orfano, serve solo `monitor.manage`. Il codice è il prossimo `SRV-<n>`,
 * mai riusato. Nasce «mai collegato»; principale il progetto, se l'ambiente
 * è la sua produzione.
 */
export async function createServer(
  input: CreateServerInput,
): Promise<{ server: ServerRow; agentKey: string; instanceUrl?: string }> {
  const me = await writer("servers.createServer");
  // Senza ambiente non c'è un progetto da guardare: l'ordine resta not_found
  // (l'ambiente), forbidden, invalid.
  const env = input.environmentId === null ? null : environmentFor(me, input.environmentId);
  if (!canMonitor(me) || (env && !holds(me, "environments.manage", env.projectId)))
    throw forbidden();
  const name = nameOf(input.name, NAME_MAX);
  if (env?.servers.some((s) => s.repositoryId === null)) throw invalid("environment");
  const code = `SRV-${++state.serverCodeSeq}`;
  const server: MonitoredServer = {
    id: newId("srv"),
    code,
    name,
    hostname: null,
    status: "never_connected",
    agentVersion: null,
    lastSeenAt: null,
    sampleIntervalSeconds: 30,
    thresholds: { ...DEFAULT_THRESHOLDS },
    services: [],
    disks: [],
    createdAt: now(),
    sshReachable: true,
    // L'opzione «operazioni» dell'installazione è spenta di default (F4b).
    agentOperations: false,
  };
  state.servers.push(server);
  env?.servers.push({ repositoryId: null, serverCode: code, reportedSha: null, reportedAt: null });
  recordServerChange(me, "server.created", server, { scope: env ? "project" : "orphan" });
  return { server: serverRow(me, server), agentKey: newAgentKey(code) };
}

/** Una chiave nuova per l'agente; la vecchia smette di valere (sul web: l'hash si sostituisce). */
export async function regenerateAgentKey(
  code: string,
): Promise<{ agentKey: string; instanceUrl?: string }> {
  const me = await writer("servers.regenerateAgentKey");
  const server = managed(me, code);
  const agentKey = newAgentKey(server.code);
  // La voce dice che c'è una chiave nuova, mai la chiave.
  recordServerChange(me, "server.agent_key_regenerated", server);
  return { agentKey };
}

export interface UpdateServerInput {
  name?: string;
  sampleIntervalSeconds?: number;
}

export async function updateServer(code: string, patch: UpdateServerInput): Promise<ServerRow> {
  const me = await writer("servers.updateServer");
  const server = managed(me, code);
  const name = patch.name === undefined ? server.name : nameOf(patch.name, NAME_MAX);
  if (patch.sampleIntervalSeconds !== undefined && !isInt(patch.sampleIntervalSeconds, 10, 300))
    throw invalid("sampleIntervalSeconds");
  // Nessun progetto principale (area 8, F4b-4): l'analisi parte dal server
  // e dice lei quale progetto è la causa.
  const fieldsOf = (n: string, interval: number) => ({
    name: n,
    sampleInterval: String(interval),
  });
  const diff = changedFields(
    fieldsOf(server.name, server.sampleIntervalSeconds),
    fieldsOf(name, patch.sampleIntervalSeconds ?? server.sampleIntervalSeconds),
  );
  server.name = name;
  if (patch.sampleIntervalSeconds !== undefined)
    server.sampleIntervalSeconds = patch.sampleIntervalSeconds;
  recordServerChange(me, "server.updated", server, undefined, diff);
  return serverRow(me, server);
}

/**
 * Toglie il server: dagli ambienti (ogni riga che lo nomina), coi suoi
 * controlli, metriche e accesso SSH. Episodi e analisi restano: le task e
 * le sessioni nate da lì ne sono la storia. Il codice non si riusa.
 */
export async function deleteServer(code: string): Promise<void> {
  const me = await writer("servers.deleteServer");
  const server = managed(me, code);
  // R-L6: non mentre un'analisi lo sta guardando o una correzione è viva
  // (anche in attesa dell'approvazione del piano).
  if (state.serverAnalyses.some((a) => a.serverCode === server.code && a.outcome === "running"))
    throw invalid("busy");
  if (
    state.conversations.some(
      (c) => c.serverFix?.serverCode === server.code && c.state !== "finished",
    )
  )
    throw invalid("busy");
  // La lapide: chi lo vedeva adesso potrà leggere «deleted», gli altri no (R-G5).
  state.serverTombstones.set(server.code, [
    ...new Set(
      state.environments
        .filter((e) => e.servers.some((s) => s.serverCode === server.code))
        .map((e) => e.projectId),
    ),
  ]);
  state.servers = state.servers.filter((s) => s !== server);
  for (const env of state.environments)
    env.servers = env.servers.filter((s) => s.serverCode !== server.code);
  for (const c of state.serverChecks.filter((x) => x.serverCode === server.code))
    state.serverCheckSamples.delete(c.id);
  state.serverChecks = state.serverChecks.filter((c) => c.serverCode !== server.code);
  state.serverMetrics.delete(server.code);
  // L'accesso SSH e le sue chiavi private (in `secrets.ts`, via `access.ts`).
  dropSshAccess(server.code);
  state.fixCheckNext.delete(server.code);
  recordServerChange(me, "server.deleted", server);
}

// --- soglie -----------------------------------------------------------------

/** Le soglie intere (come il web: sostituzione, non unione); una percentuale `null` è spenta. */
export async function setThresholds(code: string, t: ServerThresholds): Promise<ServerThresholds> {
  const me = await writer("servers.setThresholds");
  const server = managed(me, code);
  for (const key of ["cpuPct", "memPct", "diskPct"] as const) {
    const v = t[key];
    if (v !== null && !(typeof v === "number" && v >= 1 && v <= 100)) throw invalid(key);
  }
  if (!isInt(t.sustainedMinutes, 1, 60)) throw invalid("sustainedMinutes");
  // Valori stabili: la percentuale come numero in stringa, `null` = spenta.
  const fieldsOf = (x: ServerThresholds) => ({
    cpu: x.cpuPct === null ? null : String(x.cpuPct),
    mem: x.memPct === null ? null : String(x.memPct),
    disk: x.diskPct === null ? null : String(x.diskPct),
    sustained: String(x.sustainedMinutes),
  });
  const diff = changedFields(fieldsOf(server.thresholds), fieldsOf(t));
  server.thresholds = {
    cpuPct: t.cpuPct,
    memPct: t.memPct,
    diskPct: t.diskPct,
    sustainedMinutes: t.sustainedMinutes,
  };
  recordServerChange(me, "server.thresholds_changed", server, undefined, diff);
  return copy(server.thresholds);
}

// --- controlli --------------------------------------------------------------

export interface CheckInput {
  name: string;
  type: ServerCheck["type"];
  /** URL, host:porta, nome del processo o stringa di connessione. */
  target: string;
  intervalSeconds: number;
  enabled: boolean;
}

/** Valida un controllo intero (dopo l'unione con la patch) e lo restituisce pulito. */
function checkFields(input: CheckInput): CheckInput {
  const name = nameOf(input.name, CHECK_NAME_MAX);
  if (!CHECK_TYPES.includes(input.type)) throw invalid("type");
  const target = typeof input.target === "string" ? input.target.trim() : "";
  if (!target) throw invalid("target");
  if (!isInt(input.intervalSeconds, 10, 3600)) throw invalid("intervalSeconds");
  return {
    name,
    type: input.type,
    target,
    intervalSeconds: input.intervalSeconds,
    enabled: !!input.enabled,
  };
}

/** I controlli il cui bersaglio è un DSN con la password dentro. */
const isDbCheck = (type: ServerCheck["type"]) => type === "postgres" || type === "mysql";

/** Un controllo nuovo: stato sconosciuto finché l'agente non lo prova. */
export async function createCheck(code: string, input: CheckInput): Promise<ServerCheck> {
  const me = await writer("servers.createCheck");
  const server = managed(me, code);
  // Un DSN nuovo di un database porta la password: la riconferma, come la rotta.
  if (isDbCheck(input.type) && requireReauth(me, "servers.createCheck"))
    throw new Error("reauth_required");
  // M6, come la rotta: un `***` è una lettura rimandata indietro, mai una
  // password; credenziali nuove in un http chiedono la riconferma.
  const target = typeof input.target === "string" ? input.target : "";
  if (hasMaskedCredentials(target)) throw invalid("masked_credentials");
  if (
    !isDbCheck(input.type) &&
    hasUrlCredentials(target) &&
    requireReauth(me, "servers.createCheck")
  )
    throw new Error("reauth_required");
  const check: ServerCheck = {
    id: newId("chk"),
    serverCode: server.code,
    ...checkFields(input),
    status: "unknown",
    latencyMs: null,
    lastError: null,
  };
  state.serverChecks.push(check);
  recordServerChange(me, "server.check_changed", server, { check: check.name });
  return checkView(check);
}

export async function updateCheck(
  checkId: string,
  patch: Partial<CheckInput>,
): Promise<ServerCheck> {
  const me = await writer("servers.updateCheck");
  const check = checkFor(me, checkId);
  if (!canMonitor(me)) throw forbidden();
  // M6, come la rotta: il target mascherato rimandato com'è da un form vale
  // «invariato» (la password salvata resta, nessuna riconferma). Nel finto
  // vale anche per il DSN di un database, che qui si legge mascherato (il
  // server non lo restituisce affatto), finché resta un database.
  const nextType = patch.type ?? check.type;
  const keepsTarget =
    patch.target !== undefined &&
    isDbCheck(nextType) === isDbCheck(check.type) &&
    hasUrlCredentials(check.target) &&
    patch.target === maskUrlCredentials(check.target);
  if (keepsTarget) patch = { ...patch, target: undefined };
  if (patch.target !== undefined) {
    if (hasMaskedCredentials(patch.target)) throw invalid("masked_credentials");
    if (
      !isDbCheck(nextType) &&
      hasUrlCredentials(patch.target) &&
      requireReauth(me, "servers.updateCheck")
    )
      throw new Error("reauth_required");
  }
  // Un DSN nuovo di un database porta la password: la riconferma, come la rotta.
  const dsnChanged = patch.target !== undefined && patch.target !== check.target;
  if (
    dsnChanged &&
    isDbCheck(patch.type ?? check.type) &&
    requireReauth(me, "servers.updateCheck")
  ) {
    throw new Error("reauth_required");
  }
  const fields = checkFields({
    name: patch.name ?? check.name,
    type: patch.type ?? check.type,
    target: patch.target ?? check.target,
    intervalSeconds: patch.intervalSeconds ?? check.intervalSeconds,
    enabled: patch.enabled ?? check.enabled,
  });
  // Il nome della voce è quello di ADESSO (se lo rinomini, la frase dice il nuovo).
  const toFields = (c: CheckInput) => ({
    name: c.name,
    checkType: c.type,
    target: c.target,
    interval: String(c.intervalSeconds),
    checkEnabled: c.enabled,
  });
  // Il confronto in chiaro (una password cambiata è un cambio), poi la
  // maschera: mai la password nel registro (M6, come `recordChange` del server).
  const raw = changedFields(toFields(check), toFields(fields));
  const diff = raw && {
    before: maskUrlCredentials(raw.before),
    after: maskUrlCredentials(raw.after),
  };
  Object.assign(check, fields);
  recordServerChange(
    me,
    "server.check_changed",
    { code: check.serverCode },
    { check: check.name },
    diff,
  );
  return checkView(check);
}

export async function deleteCheck(checkId: string): Promise<void> {
  const me = await writer("servers.deleteCheck");
  const check = checkFor(me, checkId);
  if (!canMonitor(me)) throw forbidden();
  state.serverChecks = state.serverChecks.filter((c) => c !== check);
  state.serverCheckSamples.delete(check.id);
  recordServerChange(me, "server.check_changed", { code: check.serverCode }, { check: check.name });
}
