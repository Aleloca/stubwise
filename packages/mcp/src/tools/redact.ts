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
  // L'URL di un webhook in uscita (Slack, Discord) è una credenziale al portatore (revisione del lotto 6, I2).
  "webhookUrl",
]);

const HIDDEN = "[nascosto: si vede dall'app]";

/**
 * Una copia di `value` coi PERCORSI nascosti: quelli che la voce del catalogo
 * dichiara (`redact`), per i segreti con un nome comune (l'`url` di un webhook
 * in uscita). Forma: `url`, `[].url`, `items.[].url`. Revisione del lotto 6 (I2).
 */
export function redactPaths(value: unknown, paths: readonly string[]): unknown {
  let out = value;
  for (const path of paths) out = redactPath(out, path.split("."));
  return out;
}

function redactPath(value: unknown, steps: string[]): unknown {
  if (steps.length === 0) return value;
  const [step, ...rest] = steps as [string, ...string[]];
  if (step === "[]") return Array.isArray(value) ? value.map((v) => redactPath(v, rest)) : value;
  if (value === null || typeof value !== "object" || Array.isArray(value) || !(step in value)) return value;
  const obj = value as Record<string, unknown>;
  const current = obj[step];
  if (rest.length === 0) return { ...obj, [step]: current === null || current === "" || current === undefined ? current : HIDDEN };
  return { ...obj, [step]: redactPath(current, rest) };
}

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
