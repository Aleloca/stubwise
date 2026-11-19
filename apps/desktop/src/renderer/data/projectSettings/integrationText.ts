// I testi di Integration (area 9c; area 9, F5), puri: li compongono sia il
// prototipo sia la build app, dove la chiave intera esce una volta sola
// (`regenerateIngestionKey`) e altrimenti si mostra mascherata.

export const maskKey = (last4: string) => `••••${last4}`;

/**
 * Il DSN: la chiave come utente dell'indirizzo, sulla base senza chiave
 * (`https://host/p/<slug>` del server, come il web).
 */
export const dsnWithKey = (base: string, key: string) => base.replace("://", `://${key}@`);

/** Lo snippet `init()` dell'SDK, sei righe. */
export const snippetOf = (dsn: string) =>
  [
    'import { init } from "@stubwise/sdk/browser";',
    "",
    "init({",
    `  dsn: "${dsn}",`,
    '  environment: "production",',
    "});",
  ].join("\n");

/**
 * La guida passo passo dell'SDK (in inglese, come sul web: è un documento
 * tecnico da dare a chi integra), con la chiave che le si passa.
 */
export function guideText(
  project: { name: string; code: string },
  dsn: string,
  key: string,
): string {
  return [
    `# Send ${project.name}'s errors to Stubwise`,
    "",
    "## 1. Install",
    "",
    "```sh",
    "npm install @stubwise/sdk",
    "```",
    "",
    "## 2. Init, as early as possible",
    "",
    "```ts",
    snippetOf(dsn),
    "```",
    "",
    "## 3. Test",
    "",
    "```ts",
    'import { captureError } from "@stubwise/sdk/browser";',
    'captureError(new Error("Stubwise test error"));',
    "```",
    "",
    `The error appears in ${project.code} within a minute. Requests with a`,
    `missing or old key are refused: the ingestion key is \`${key}\`.`,
    "",
  ].join("\n");
}
