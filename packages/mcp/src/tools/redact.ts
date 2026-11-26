/**
 * I segreti che viaggiano DENTRO una lettura ordinaria del server (la chiave
 * d'ingestione nell'elenco dei progetti, il token di un invito, il segreto del
 * webhook di un repository appena creato) non arrivano al modello: `read_action`
 * e `write_action` li nascondono prima di mostrare la risposta (lotto 6 della
 * parità, design `docs/plans/2026-11-26-mcp-parita-design.md`). Si vedono
 * dall'app.
 *
 * Per NOME del campo, a ogni profondità. Il test di parità del server
 * (`apps/server/src/mcp-parity.test.ts`) legge questo elenco dal sorgente: un
 * campo dall'aria segreta nella risposta di un'azione deve stare qui, o
 * nell'elenco chiuso dei nomi innocui di quel test.
 */
export const REDACTED_FIELDS: ReadonlySet<string> = new Set([
  "ingestionKey",
  "webhookSecret",
  "token",
  "secret",
  "password",
  "apiKey",
  "clientSecret",
  "s3AccessKey",
  "s3SecretKey",
  "slackBotToken",
  "slackSigningSecret",
]);

const HIDDEN = "[nascosto: si vede dall'app]";

/** Una copia di `value` coi segreti nascosti (un valore vuoto o null resta com'è). */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED_FIELDS.has(k) && v !== null && v !== "" && v !== undefined ? HIDDEN : redactSecrets(v);
  }
  return out;
}
