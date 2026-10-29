import type { VerifyOutcome } from "../../domain/servers/sshAccess";
import { copy, now, state } from "../store";
import type { EpisodeReason, MonitoredServer, ServerEpisode } from "../types";
import { forbidden, invalid, writer } from "../writer";
import { raiseEpisode, recoverEpisode } from "./analysis";
import { canManageSsh, serverFor } from "./visibility";

// SOLO PROTOTIPO: ciò che nel motore arriva dal server vero e che qui si
// sceglie a mano, coi «Simula …» del riquadro «Prototype only». Nessuna di
// queste funzioni tocca un accesso: fissano l'ESITO che la prossima azione
// vera leggerà, o fanno arrivare il segnale che l'agente di monitoraggio
// manderebbe (allarme, rientro) — il resto lo fa `analysis.ts`, come il
// motore.

const VERIFY_OUTCOMES: readonly VerifyOutcome[] = [
  "ok",
  "read_fails",
  "fix_fails",
  "read_writes",
  "unreachable",
];

/** «Simula: riesce / fallisce lettura / fallisce correzione / lettura scrive / irraggiungibile» per la prossima «Verifica». */
export async function simulateSshVerifyOutcome(
  code: string,
  outcome: VerifyOutcome,
): Promise<void> {
  const me = await writer("servers.simulateSshVerifyOutcome");
  const server = serverFor(me, code);
  if (!canManageSsh(me)) throw forbidden();
  if (!VERIFY_OUTCOMES.includes(outcome)) throw invalid("outcome");
  state.sshVerifyNext.set(server.code, outcome);
}

const SEVERITIES: readonly ServerEpisode["severity"][] = ["trouble", "down"];

/** Un motivo plausibile del tipo dato, dalle soglie e dai controlli del server. */
function reasonOf(server: MonitoredServer, kind: EpisodeReason["kind"]): EpisodeReason {
  const t = server.thresholds;
  switch (kind) {
    case "cpu":
      return { kind, valuePct: 97, thresholdPct: t.cpuPct ?? 95 };
    case "memory":
      return { kind, valuePct: 94, thresholdPct: t.memPct ?? 90 };
    case "disk":
      return { kind, valuePct: 96, thresholdPct: t.diskPct ?? 90 };
    case "check": {
      const checks = state.serverChecks.filter((c) => c.serverCode === server.code);
      const check = checks.find((c) => c.status === "down") ?? checks[0];
      if (!check) throw invalid("reason");
      return { kind, checkId: check.id };
    }
    case "agent_silent":
      return { kind, since: server.lastSeenAt ?? now() };
    default:
      throw invalid("reason");
  }
}

/**
 * «Simula allarme»: l'agente segnala un problema (`agent_silent` di base
 * `down`, gli altri `trouble`). Con un episodio aperto il motivo gli si
 * aggiunge; altrimenti avvisi e, se si può, l'analisi. `overrun`: l'analisi
 * arriva al limite di tempo e chiude `timed_out` con ciò che ha visto.
 */
export async function simulateServerAlert(
  code: string,
  reason: EpisodeReason["kind"],
  opts: { severity?: ServerEpisode["severity"]; overrun?: boolean } = {},
): Promise<ServerEpisode> {
  const me = await writer("servers.simulateServerAlert");
  const server = serverFor(me, code);
  const r = reasonOf(server, reason);
  const severity = opts.severity ?? (reason === "agent_silent" ? "down" : "trouble");
  if (!SEVERITIES.includes(severity)) throw invalid("severity");
  return copy(raiseEpisode(server.code, [r], severity, { overrun: opts.overrun === true }));
}

/** «Simula rientro»: l'episodio aperto si chiude; senza episodio aperto `invalid: state`. */
export async function simulateServerRecovery(code: string): Promise<ServerEpisode> {
  const me = await writer("servers.simulateServerRecovery");
  const server = serverFor(me, code);
  const ep = recoverEpisode(server.code);
  if (!ep) throw invalid("state");
  return copy(ep);
}

const FIX_CHECK_OUTCOMES = ["resolved", "not_resolved"] as const;

/**
 * «Simula: risolto / non risolto» per il prossimo controllo finale di una
 * correzione su quel server (di base risolto); vale una volta sola.
 */
export async function simulateFixCheck(
  code: string,
  outcome: (typeof FIX_CHECK_OUTCOMES)[number],
): Promise<void> {
  const me = await writer("servers.simulateFixCheck");
  const server = serverFor(me, code);
  if (!FIX_CHECK_OUTCOMES.includes(outcome)) throw invalid("outcome");
  state.fixCheckNext.set(server.code, outcome);
}

/** «Simula server irraggiungibile»: l'SSH non risponde (`on`), o torna a rispondere. */
export async function simulateSshUnreachable(code: string, on: boolean): Promise<void> {
  const me = await writer("servers.simulateSshUnreachable");
  const server = serverFor(me, code);
  server.sshReachable = !on;
}
