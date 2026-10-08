/**
 * Oscura i valori segreti prima che un evento di sessione venga salvato o
 * inoltrato (spec §5.5): i `.env` materializzati in TUTTI i repo del run
 * (`AgentRunSession.secrets`, Task 8) più la credenziale del provider e i
 * valori di `extraEnv`, che aggiunge il runner (Task 5). Difesa PARZIALE per
 * costruzione: un valore derivato, codificato o spezzato fra due parziali
 * passa. Sotto MIN_SECRET_LENGTH non si oscura: trasformerebbe ogni `true` o
 * `1` del transcript in `•••`.
 */
export const REDACTED = "•••";
export const MIN_SECRET_LENGTH = 6;

export type Redactor = <T>(value: T) => T;

export function createRedactor(secrets: Iterable<string>): Redactor {
  const values = [...new Set(secrets)]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  if (values.length === 0) return <T>(value: T) => value;
  const replace = (text: string): string =>
    values.reduce((acc, secret) => acc.split(secret).join(REDACTED), text);
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return replace(value);
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return <T>(value: T) => walk(value) as T;
}
