import { z } from "zod";

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const envSchema = z.object({
  DATABASE_URL: z.url({
    error: (issue) =>
      issue.input === undefined
        ? "variabile mancante: URL di connessione Postgres (es. postgres://user:pass@host:5432/stubwise)"
        : "deve essere un URL di connessione valido (es. postgres://user:pass@host:5432/stubwise)",
  }),
  SESSION_SECRET: z
    .string({
      error: () => "variabile mancante: segreto per le sessioni (genera con: openssl rand -hex 32)",
    })
    .min(32, "deve essere lunga almeno 32 caratteri (genera con: openssl rand -hex 32)"),
  ENCRYPTION_KEY: z
    .string({
      error: () =>
        "variabile mancante: chiave di cifratura (genera con: openssl rand -base64 32)",
    })
    .refine((value) => BASE64_RE.test(value) && Buffer.from(value, "base64").length === 32, {
      error: "deve essere 32 byte codificati in base64 (genera con: openssl rand -base64 32)",
    }),
  PORT: z.coerce
    .number({ error: "deve essere un numero di porta valido (es. 3000)" })
    .int("deve essere un numero di porta valido (es. 3000)")
    .min(1)
    .max(65535)
    .default(3000),
  PUBLIC_URL: z.url({
    error: (issue) =>
      issue.input === undefined
        ? "variabile mancante: URL pubblico dell'istanza (es. https://stubwise.example.com)"
        : "deve essere un URL valido (es. https://stubwise.example.com)",
  }),
});

export interface Config {
  databaseUrl: string;
  sessionSecret: string;
  encryptionKey: string;
  port: number;
  publicUrl: string;
}

/**
 * Valida le variabili d'ambiente e restituisce la configurazione.
 * Lancia un errore con un messaggio leggibile che elenca ogni variabile
 * mancante o non valida (esperienza self-hosting).
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(
      [
        "Configurazione non valida. Correggi queste variabili d'ambiente:",
        ...lines,
        "Vedi .env.example per la descrizione di ogni variabile.",
      ].join("\n"),
    );
  }
  const parsed = result.data;
  return {
    databaseUrl: parsed.DATABASE_URL,
    sessionSecret: parsed.SESSION_SECRET,
    encryptionKey: parsed.ENCRYPTION_KEY,
    port: parsed.PORT,
    publicUrl: parsed.PUBLIC_URL,
  };
}
