import type { VerifyOutcome } from "../../domain/servers/sshAccess";
import { state } from "../store";
import { forbidden, invalid, writer } from "../writer";
import { canManageSsh, serverFor } from "./visibility";

// SOLO PROTOTIPO: ciò che nel motore arriva dal server vero e che qui si
// sceglie a mano, coi «Simula …» del riquadro «Prototype only». Nessuna di
// queste funzioni tocca un accesso: fissano l'ESITO che la prossima azione
// vera leggerà.

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
