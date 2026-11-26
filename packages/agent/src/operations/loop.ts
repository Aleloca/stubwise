import { executeAction, type DockerRequest } from "./execute.js";
import { verifyCommand, type NonceStore, type SignedCommand } from "./verify.js";

/**
 * Area 8, F4b: the operations loop, ONLY when `STUBWISE_OPERATIONS=1`. The
 * agent pulls at most one command per tick (`GET /monitor/commands`, its own
 * `sk_…` key; no port open on the host), verifies it (`verifyCommand`), runs it
 * through the fixed table (`executeAction`) and reports the result. A refused
 * command is reported too (exit 126 with the reason), never run.
 */

export interface OperationsDeps {
  baseUrl: string;
  serverKey: string;
  publicKey: string;
  nonces: NonceStore;
  docker: DockerRequest;
  seenContainers: () => readonly string[];
  serverId: () => string | null;
  /**
   * Review F4b, I2: fissa l'id del server se non lo è ancora (una config
   * mancata all'avvio). Chiamata a ogni giro PRIMA della verifica: senza,
   * un agente partito con Stubwise irraggiungibile rifiuterebbe per sempre.
   */
  refreshServerId?: () => Promise<void>;
  fetchFn?: typeof fetch;
  now?: () => Date;
  log?: (msg: string) => void;
}

export async function operationsTick(deps: OperationsDeps): Promise<"idle" | "ran" | "refused"> {
  const f = deps.fetchFn ?? fetch;
  const headers = { "x-stubwise-server-key": deps.serverKey };
  const res = await f(`${deps.baseUrl}/monitor/commands`, { headers });
  if (!res.ok) return "idle";
  const body = (await res.json()) as { command: SignedCommand | null };
  if (!body.command) return "idle";
  if (deps.serverId() === null) await deps.refreshServerId?.().catch(() => undefined);
  const now = deps.now?.() ?? new Date();
  const verdict = verifyCommand(body.command, {
    publicKey: deps.publicKey,
    serverId: deps.serverId(),
    now,
    nonces: deps.nonces,
    seenContainers: deps.seenContainers(),
  });
  const report = async (exitCode: number, output: string, id: string) =>
    f(`${deps.baseUrl}/monitor/commands/${encodeURIComponent(id)}/result`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ exitCode, output }),
    });
  if (!verdict.ok) {
    deps.log?.(`[stubwise-agent] command refused: ${verdict.reason}`);
    if (verdict.commandId && /^[0-9a-f-]{36}$/i.test(verdict.commandId)) await report(126, `refused: ${verdict.reason}`, verdict.commandId);
    return "refused";
  }
  const result = await executeAction(deps.docker, verdict.action, now);
  await report(result.exitCode, result.output, verdict.commandId);
  return "ran";
}

export function startOperationsLoop(deps: OperationsDeps, intervalMs = 15_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    operationsTick(deps)
      .catch((error: unknown) => deps.log?.(`[stubwise-agent] operations tick failed: ${String(error)}`))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}
