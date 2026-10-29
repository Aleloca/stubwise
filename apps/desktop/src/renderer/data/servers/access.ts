import { removalScript } from "../../domain/servers/installScript";
import { accessState, type AccessState, type VerifyOutcome } from "../../domain/servers/sshAccess";
import { now, state } from "../store";
import type {
  MonitoredServer,
  ServerSshAccess,
  SshAccessKind,
  SshUse,
  SshVerification,
} from "../types";
import { forbidden, invalid, writer } from "../writer";
import { forget, promotePending, storeKeyPair } from "./secrets";
import {
  canManageSsh,
  installCommandOf,
  serverFor,
  sshAccessView,
  type SshAccessView,
} from "./visibility";

// Gli accessi SSH dei server (area 8b, decisione 12): collega → comando →
// «Verifica», poi Rigenera e Revoca. Tutto sotto `servers.ssh.manage`
// (d'istanza). Gli errori: `not_found` per un server che chi agisce non
// vede (R-G5, prima di tutto), `forbidden` senza il permesso, `invalid:
// state` per un'azione che lo stato dell'accesso non ammette.
//
// Le private le genera e le custodisce `secrets.ts`; qui passano solo le
// pubbliche, che finiscono nello stato e nel comando (anti-obiettivo 3).
//
// Le regole che reggono il modello (`ServerSshAccess`):
// - con `pending` una verifica tutta `ok` promuove le nuove e dimentica le
//   vecchie; altrimenti le vecchie restano, e il loro esito si conserva in
//   `keysVerification` — usabili solo se lo erano prima di «Rigenera»;
// - una lettura che scrive spegne entrambi gli accessi finché una verifica
//   non riesce (`accessState`/`accessUsable`).

/** Chi si ferma quando un accesso viene revocato (la correzione viva sul server, Task 6). */
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

/** Una coppia nuova, in attesa: le private in `secrets.ts`, qui le pubbliche. */
const newPendingPair = (code: string) => ({
  read: storeKeyPair(code, "read", true),
  fix: storeKeyPair(code, "fix", true),
});

const commandOf = (code: string): string => installCommandOf(code)!;

/** «Collega l'accesso SSH»: genera le due coppie e restituisce il comando da incollare. */
export async function linkSshAccess(code: string): Promise<{ command: string }> {
  const me = await writer("servers.linkSshAccess");
  const server = managed(me, code);
  stateOf(server.code, ["not_linked", "revoked"]);
  const prev = state.serverAccess.get(server.code);
  state.serverAccess.set(server.code, {
    serverCode: server.code,
    keys: null,
    pending: newPendingPair(server.code),
    verification: null,
    keysVerification: null,
    // L'ultimo uso è dell'accesso al server, non delle chiavi: resta.
    lastUse: prev?.lastUse ?? {},
    revokedAt: null,
  });
  // Un esito simulato prima del collegamento non riguarda queste chiavi.
  state.sshVerifyNext.delete(server.code);
  return { command: commandOf(server.code) };
}

/** L'esito simulato di una verifica (solo prototipo: nel motore è una prova SSH vera). */
function verificationOf(server: MonitoredServer, outcome: VerifyOutcome, ofPending: boolean) {
  const base = { at: now(), ofPending };
  switch (outcome) {
    case "ok":
      return { ...base, read: "ok", fix: "ok", reason: null } as const;
    case "read_fails":
      return {
        ...base,
        read: "failed",
        fix: "ok",
        reason: "stubwise-read: Permission denied (publickey).",
      } as const;
    case "fix_fails":
      return {
        ...base,
        read: "ok",
        fix: "failed",
        reason: "stubwise-fix: Permission denied (publickey).",
      } as const;
    case "read_writes":
      return {
        ...base,
        read: "writes",
        fix: "ok",
        reason: "stubwise-read can write: sudo -n true succeeded.",
      } as const;
    case "unreachable":
      return {
        ...base,
        read: "failed",
        fix: "failed",
        reason: `ssh: connect to host ${server.hostname ?? server.code} port 22: Connection timed out.`,
      } as const;
  }
}

/**
 * «Verifica»: prova i due accessi (esito da `sshVerifyNext`, di base `ok`;
 * `unreachable` se il server non risponde via SSH). Con chiavi in attesa
 * un esito tutto `ok` le promuove e dimentica le vecchie; altrimenti le
 * vecchie restano, col loro esito di prima.
 */
export async function verifySshAccess(code: string): Promise<SshAccessView> {
  const me = await writer("servers.verifySshAccess");
  const server = managed(me, code);
  const a = state.serverAccess.get(server.code);
  if (!a || (a.keys === null && a.pending === null)) throw invalid("state");
  const outcome =
    state.sshVerifyNext.get(server.code) ?? (server.sshReachable ? "ok" : "unreachable");
  state.sshVerifyNext.delete(server.code);
  const result: SshVerification = verificationOf(server, outcome, a.pending !== null);
  if (a.pending === null) {
    a.verification = result;
    a.keysVerification = null;
  } else if (outcome === "ok") {
    promotePending(server.code);
    a.keys = a.pending;
    a.pending = null;
    a.verification = { ...result, ofPending: false };
    a.keysVerification = null;
  } else {
    // L'esito delle vecchie si conserva alla prima verifica delle nuove.
    if (a.keys !== null && !a.verification?.ofPending) a.keysVerification = a.verification;
    a.verification = result;
  }
  return sshAccessView(me, server.code);
}

/**
 * «Rigenera»: chiavi nuove in attesa e il loro comando; le vecchie restano
 * in uso (se lo erano) finché la verifica delle nuove non riesce. Delle
 * chiavi in attesa di prima, se c'erano, non resta nulla.
 */
export async function regenerateSshAccess(code: string): Promise<{ command: string }> {
  const me = await writer("servers.regenerateSshAccess");
  const server = managed(me, code);
  stateOf(server.code, ["verified", "verify_failed", "read_writes"]);
  const a = state.serverAccess.get(server.code)!;
  a.pending = newPendingPair(server.code);
  // La verifica corrente torna a essere quella delle chiavi in uso (o
  // nessuna, se non ce ne sono): le nuove non sono ancora state provate.
  if (a.verification?.ofPending) a.verification = a.keysVerification;
  a.keysVerification = null;
  return { command: commandOf(server.code) };
}

/**
 * «Revoca»: Stubwise dimentica le chiavi e mostra il comando che toglie i
 * due utenti dal server; chi lavorava sul server con l'accesso si ferma.
 */
export async function revokeSshAccess(code: string): Promise<{ removalCommand: string }> {
  const me = await writer("servers.revokeSshAccess");
  const server = managed(me, code);
  stateOf(server.code, [
    "awaiting_command",
    "verified",
    "verify_failed",
    "read_writes",
    "regenerating",
  ]);
  const a = state.serverAccess.get(server.code)!;
  forget(server.code);
  a.keys = null;
  a.pending = null;
  a.verification = null;
  a.keysVerification = null;
  a.revokedAt = now();
  state.sshVerifyNext.delete(server.code);
  // Le chiavi sono già dimenticate: un gancio che lancia non fa sembrare
  // fallita una revoca avvenuta, né ferma gli altri.
  for (const fn of revokedHooks) {
    try {
      fn(server.code);
    } catch (e) {
      console.error("onAccessRevoked", e);
    }
  }
  return { removalCommand: removalScript(server.code) };
}

/** Un server tolto dal monitor: via anche le chiavi (`deleteServer`). */
export function dropSshAccess(serverCode: string): void {
  forget(serverCode);
  state.serverAccess.delete(serverCode);
  state.sshVerifyNext.delete(serverCode);
}

/**
 * L'ultimo uso di un accesso (analisi, Task 5; correzione, Task 6). Chi
 * chiama ha già deciso che l'accesso è usabile: qui si registra soltanto.
 */
export function markUsed(serverCode: string, kind: SshAccessKind, ref: SshUse["ref"]): void {
  const a: ServerSshAccess | undefined = state.serverAccess.get(serverCode);
  if (!a) return;
  a.lastUse[kind] = { at: now(), ref: structuredClone(ref) };
}
