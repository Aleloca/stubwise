import { removalScript } from "../../domain/servers/installScript";
import {
  accessState,
  JOURNAL_GROUPS,
  SSH_READ_USER,
  type AccessState,
  type VerifyOutcome,
} from "../../domain/servers/sshAccess";
import { now, state } from "../store";
import type { MonitoredServer, ServerSshAccess, SshUse, SshVerification } from "../types";
import { forbidden, invalid, writer } from "../writer";
import { recordServerChange } from "./changes";
import { forget, promotePending, storeKeyPair } from "./secrets";
import {
  canManageSsh,
  installCommandOf,
  serverFor,
  sshAccessView,
  type SshAccessView,
} from "./visibility";

// L'accesso SSH dei server (area 8, F4b, Q3 = b): UNO, di sola lettura
// (`stubwise-read`), usato solo dall'analisi. Collega → comando →
// «Verifica», poi Rigenera e Revoca. Tutto sotto `servers.ssh.manage`
// (d'istanza). Gli errori: `not_found` per un server che chi agisce non
// vede (R-G5, prima di tutto), `forbidden` senza il permesso, `invalid:
// state` per un'azione che lo stato dell'accesso non ammette.
//
// Le private le genera e le custodisce `secrets.ts`; qui passano solo le
// pubbliche, che finiscono nello stato e nel comando (anti-obiettivo 3).
//
// Le regole che reggono il modello (`ServerSshAccess`):
// - la verifica dice che cosa l'utente può fare: i gruppi, `sudo` (deve
//   essere NO), `docker` (NO: il socket vale root), il journal
//   (`systemd-journal` o `adm`, F4b-3); `ok` solo entrato e senza i primi due;
// - con `pending` una verifica `ok` promuove la nuova e dimentica la
//   vecchia; altrimenti la vecchia resta, e il suo esito si conserva in
//   `keyVerification` — usabile solo se lo era prima di «Rigenera»;
// - un utente con più della lettura spegne l'accesso finché una verifica
//   non riesce (`accessState`/`accessUsable`).

/** Chi si ferma quando l'accesso viene revocato (l'analisi in corso sul server). */
const revokedHooks = new Set<(serverCode: string) => void>();

/** Iscrive `fn` alle revoche; restituisce la funzione che lo disiscrive. Resta iscritto anche dopo `resetApi`. */
export function onAccessRevoked(fn: (serverCode: string) => void): () => void {
  revokedHooks.add(fn);
  return () => revokedHooks.delete(fn);
}

/** Il server su cui agire: visibile (o `not_found`), con `servers.ssh.manage` (o `forbidden`). */
function managed(me: string, code: string): MonitoredServer {
  const server = serverFor(me, code);
  if (!canManageSsh(me)) throw forbidden();
  return server;
}

function stateOf(code: string, allowed: readonly AccessState[]): void {
  if (!allowed.includes(accessState(state.serverAccess.get(code)))) throw invalid("state");
}

/** Una coppia nuova, in attesa: la privata in `secrets.ts`, qui la pubblica. */
const newPendingKey = (code: string) => storeKeyPair(code, true);

const commandOf = (code: string): string => installCommandOf(code)!;

/** «Collega l'accesso SSH»: genera la coppia e restituisce il comando da incollare. */
export async function linkSshAccess(code: string): Promise<{ command: string }> {
  const me = await writer("servers.linkSshAccess");
  const server = managed(me, code);
  stateOf(server.code, ["not_linked", "revoked"]);
  const prev = state.serverAccess.get(server.code);
  state.serverAccess.set(server.code, {
    serverCode: server.code,
    key: null,
    pending: newPendingKey(server.code),
    verification: null,
    keyVerification: null,
    // L'ultimo uso è dell'accesso al server, non della chiave: resta.
    lastUse: prev?.lastUse ?? null,
    revokedAt: null,
  });
  // Un esito simulato prima del collegamento non riguarda queste chiavi.
  state.sshVerifyNext.delete(server.code);
  recordServerChange(me, "server.ssh_access_changed", server);
  return { command: commandOf(server.code) };
}

/**
 * L'esito simulato di una verifica (solo prototipo: nel motore è una prova
 * SSH vera — il login, poi `id -nG` e `sudo -n true`). `ok` solo entrato,
 * senza `sudo` e senza il gruppo `docker`.
 */
function verificationOf(
  server: MonitoredServer,
  outcome: VerifyOutcome,
  ofPending: boolean,
): SshVerification {
  const entered = (groups: string[], reason: string | null): SshVerification => {
    const sudo = groups.includes("sudo");
    const docker = groups.includes("docker");
    return {
      at: now(),
      login: "ok",
      groups,
      sudo,
      docker,
      journal: groups.some((g) => JOURNAL_GROUPS.includes(g)),
      ok: !sudo && !docker,
      reason,
      ofPending,
    };
  };
  const refused = (login: "denied" | "unreachable", reason: string): SshVerification => ({
    at: now(),
    login,
    groups: [],
    sudo: false,
    docker: false,
    journal: false,
    ok: false,
    reason,
    ofPending,
  });
  switch (outcome) {
    case "ok":
      return entered([SSH_READ_USER, "systemd-journal"], null);
    case "no_journal":
      return entered([SSH_READ_USER], null);
    case "sudo":
      return entered(
        [SSH_READ_USER, "sudo"],
        `${SSH_READ_USER} can run sudo: sudo -n true succeeded.`,
      );
    case "docker":
      return entered(
        [SSH_READ_USER, "docker"],
        `${SSH_READ_USER} is in the docker group: it can control every container.`,
      );
    case "denied":
      return refused("denied", `${SSH_READ_USER}: Permission denied (publickey).`);
    case "unreachable":
      return refused(
        "unreachable",
        `ssh: connect to host ${server.hostname ?? server.code} port 22: Connection timed out.`,
      );
  }
}

/**
 * «Verifica»: prova l'accesso (esito da `sshVerifyNext`, di base `ok`;
 * `unreachable` se il server non risponde via SSH). Con una chiave in
 * attesa un esito `ok` la promuove e dimentica la vecchia; altrimenti la
 * vecchia resta, col suo esito di prima.
 */
export async function verifySshAccess(code: string): Promise<SshAccessView> {
  const me = await writer("servers.verifySshAccess");
  const server = managed(me, code);
  const a = state.serverAccess.get(server.code);
  if (!a || (a.key === null && a.pending === null)) throw invalid("state");
  const outcome =
    state.sshVerifyNext.get(server.code) ?? (server.sshReachable ? "ok" : "unreachable");
  state.sshVerifyNext.delete(server.code);
  const stateBefore = accessState(a);
  const result = verificationOf(server, outcome, a.pending !== null);
  if (a.pending === null) {
    a.verification = result;
    a.keyVerification = null;
  } else if (result.ok) {
    promotePending(server.code);
    a.key = a.pending;
    a.pending = null;
    a.verification = { ...result, ofPending: false };
    a.keyVerification = null;
  } else {
    // L'esito della vecchia si conserva alla prima verifica della nuova.
    if (a.key !== null && !a.verification?.ofPending) a.keyVerification = a.verification;
    a.verification = result;
  }
  // Una verifica è una prova, non un cambio: la voce c'è solo se l'accesso
  // passa a un altro stato (verificato, non verificato, con più della lettura…).
  if (accessState(a) !== stateBefore) recordServerChange(me, "server.ssh_access_changed", server);
  return sshAccessView(me, server.code);
}

/**
 * «Rigenera»: una coppia nuova in attesa e il suo comando. La vecchia smette
 * SUBITO di valere (decisione del maintainer, 15 nov 2026, come il server:
 * mai due chiavi insieme): la sua privata si dimentica adesso, e finché la
 * nuova non passa la verifica Claude analizza senza letture SSH.
 */
export async function regenerateSshAccess(code: string): Promise<{ command: string }> {
  const me = await writer("servers.regenerateSshAccess");
  const server = managed(me, code);
  stateOf(server.code, ["verified", "verify_failed", "privileged"]);
  const a = state.serverAccess.get(server.code)!;
  forget(server.code);
  a.key = null;
  a.pending = newPendingKey(server.code);
  // La nuova non è ancora stata provata: nessuna verifica vale.
  a.verification = null;
  a.keyVerification = null;
  recordServerChange(me, "server.ssh_access_changed", server);
  return { command: commandOf(server.code) };
}

/**
 * «Revoca»: Stubwise dimentica la chiave e mostra il comando che toglie
 * l'utente dal server; l'analisi che leggeva con l'accesso si ferma. Una
 * correzione no: passa dall'agente, non dall'SSH.
 */
export async function revokeSshAccess(code: string): Promise<{ removalCommand: string }> {
  const me = await writer("servers.revokeSshAccess");
  const server = managed(me, code);
  stateOf(server.code, ["awaiting_command", "verified", "verify_failed", "privileged"]);
  const a = state.serverAccess.get(server.code)!;
  forget(server.code);
  a.key = null;
  a.pending = null;
  a.verification = null;
  a.keyVerification = null;
  a.revokedAt = now();
  state.sshVerifyNext.delete(server.code);
  // La chiave è già dimenticata: un gancio che lancia non fa sembrare
  // fallita una revoca avvenuta, né ferma gli altri.
  for (const fn of revokedHooks) {
    try {
      fn(server.code);
    } catch (e) {
      console.error("onAccessRevoked", e);
    }
  }
  recordServerChange(me, "server.ssh_access_changed", server);
  return { removalCommand: removalScript(server.code) };
}

/** Un server tolto dal monitor: via anche la chiave (`deleteServer`). */
export function dropSshAccess(serverCode: string): void {
  forget(serverCode);
  state.serverAccess.delete(serverCode);
  state.sshVerifyNext.delete(serverCode);
}

/**
 * L'ultimo uso dell'accesso (l'analisi). Chi chiama ha già deciso che
 * l'accesso è usabile: qui si registra soltanto.
 */
export function markUsed(serverCode: string, ref: SshUse["ref"]): void {
  const a: ServerSshAccess | undefined = state.serverAccess.get(serverCode);
  if (!a) return;
  a.lastUse = { at: now(), ref: structuredClone(ref) };
}
