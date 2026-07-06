import { buildDsn, toFileSlug } from "./install-guide-shared";

/** Nome file suggerito per il download della guida SDK di un progetto. */
export function sdkGuideFilename(projectSlug: string): string {
  return `stubwise-sdk-${toFileSlug(projectSlug, "project")}.md`;
}

interface SdkInstallGuideInput {
  projectSlug: string;
  projectName: string;
  /** Ingestion key del PROGETTO: entra nel DSN e nell'header X-Stubwise-Key. */
  ingestionKey: string;
  /** Origin dell'istanza Stubwise (es. `window.location.origin`). */
  origin: string;
}

/**
 * Genera un documento markdown AUTOCONTENUTO per installare l'SDK di error
 * tracking `@stubwise/sdk` sui siti/servizi di QUESTO progetto. È scritto per
 * essere incollato a un agent AI: contiene tutti i valori REALI (DSN, ingestion
 * key, endpoint, guide URL) e nessuna fonte esterna richiesta. Funzione PURA
 * (nessun DOM): testabile in isolamento.
 *
 * Il CONTENUTO è in inglese di proposito — è un documento tecnico destinato a un
 * agent, non UI localizzata. Ogni claim sull'SDK è verificabile sul sorgente di
 * `packages/sdk` (browser.ts, node.ts, core/client.ts, core/transport.ts).
 */
export function buildSdkInstallGuide(input: SdkInstallGuideInput): string {
  const { projectSlug, projectName: rawName, ingestionKey, origin } = input;
  // Il nome può contenere newline: appiattiscilo prima di interpolarlo nel
  // markdown (titolo e key facts), come fa il server nel body del ticket.
  const projectName = rawName.replace(/\s*\n+\s*/g, " ");
  const dsn = buildDsn(ingestionKey, projectSlug, origin);
  const ingestEndpoint = `${origin}/ingest/${projectSlug}`;
  const guideUrl = `${origin}/guide/sdk/installation/`;

  const browserSnippet = [
    "```ts",
    'import { init } from "@stubwise/sdk/browser";',
    "",
    "init({",
    `  dsn: "${dsn}",`,
    '  release: "1.0.0", // optional, attached to every event',
    '  environment: "production", // optional',
    "});",
    "```",
  ].join("\n");

  const browserApiSnippet = [
    "```ts",
    'import { captureError, captureFeedback, createTicket, addBreadcrumb } from "@stubwise/sdk/browser";',
    "",
    "// Capture an error by hand (current url + userAgent are attached for you):",
    "captureError(new Error(\"payment failed\"));",
    "",
    "// User feedback; screenshot: true lazily loads html2canvas and attaches a JPEG:",
    'captureFeedback({ message: "The checkout button does nothing", email: "user@example.com", screenshot: true });',
    "",
    "// Open a ticket straight from the app:",
    'createTicket({ title: "Broken filter on /search", type: "bug", priority: "medium" });',
    "",
    "// Add your own breadcrumb (types: click | navigation | fetch | log):",
    'addBreadcrumb({ type: "log", message: "checkout started" });',
    "```",
  ].join("\n");

  const nodeSnippet = [
    "```ts",
    'import { init } from "@stubwise/sdk/node";',
    "",
    "init({",
    `  dsn: "${dsn}",`,
    '  environment: "production", // optional',
    "  registerProcessHandlers: true, // default: true",
    "});",
    "```",
  ].join("\n");

  const nodeMiddlewareSnippet = [
    "```ts",
    "// Express — register BEFORE your own error handlers; it calls next(err):",
    'import { expressErrorHandler } from "@stubwise/sdk/node";',
    "app.use(expressErrorHandler());",
    "",
    "// Fastify — it captures then rethrows to Fastify's default handler:",
    'import { fastifyErrorHandler } from "@stubwise/sdk/node";',
    "app.setErrorHandler(fastifyErrorHandler());",
    "```",
  ].join("\n");

  // Curl di verifica: body conforme a errorEventSchema (kind, message,
  // breadcrumbs: array, timestamp ISO con offset). Su una riga per copia-incolla.
  const verifyBody =
    '{"events":[{"kind":"error","message":"Stubwise ingest smoke test",' +
    '"breadcrumbs":[],"timestamp":"2026-01-01T00:00:00.000Z"}]}';
  const verifyCurl = [
    "```sh",
    `curl -X POST "${ingestEndpoint}" \\`,
    `  -H "X-Stubwise-Key: ${ingestionKey}" \\`,
    '  -H "content-type: application/json" \\',
    `  -d '${verifyBody}'`,
    "```",
  ].join("\n");

  return `# Install Stubwise error tracking in "${projectName}"

This installs the Stubwise error-tracking SDK (\`@stubwise/sdk\`) on the sites and
services of this project. The SDK automatically captures browser and Node errors,
lets users send feedback (optionally with a screenshot) and lets your app open
tickets via its API. Captured events land in the **${projectName}** project on
this Stubwise instance and become tickets. Everything you need is in this
document — no other sources required.

## Key facts

- Stubwise instance URL: ${origin}
- Project name: ${projectName}
- Project slug: ${projectSlug}
- Ingestion key (publishable): ${ingestionKey}
- DSN (connects the SDK to this project): ${dsn}
- Ingestion endpoint (where events are POSTed): ${ingestEndpoint}
- npm package (published): @stubwise/sdk
- User guide (reference only): ${guideUrl}

The DSN's \`/p/${projectSlug}\` path is mapped internally onto the
\`${ingestEndpoint}\` endpoint, and the ingestion key travels in the
\`X-Stubwise-Key\` header. You never build that URL yourself — just pass the DSN.

## Browser apps

Install the package and initialize it once, as early as possible (before your app
code runs), on every page/entry that should be tracked:

\`\`\`bash
npm install @stubwise/sdk
# or: pnpm add @stubwise/sdk / yarn add @stubwise/sdk
\`\`\`

${browserSnippet}

Once \`init()\` runs, the browser SDK installs **on its own**, with no further
setup:

- a global \`error\` listener and an \`unhandledrejection\` listener — unhandled
  errors and rejected promises are captured automatically;
- automatic **breadcrumbs** attached to every captured error: **clicks**
  (\`tag#id\` / \`tag.class\`, identical repeats throttled), **navigations**
  (\`pushState\`/\`replaceState\`, \`popstate\`, \`hashchange\`) and **failed
  fetches** (only responses \`>= 400\` or network errors; POSTs to the ingestion
  endpoint itself are excluded to avoid loops);
- a **flush with \`keepalive\`** on \`pagehide\` and when the page becomes hidden
  (\`visibilitychange\`), so the last events aren't lost when the page unloads.

You don't have to call anything for the above. These optional APIs are available
when you want manual capture:

${browserApiSnippet}

\`captureFeedback\`'s \`screenshot\` and the \`url\`/\`userAgent\` defaults are
**browser-only**. All of these are safe to call before \`init()\` (they warn once
and no-op).

## Node services

For Node backends install the same package and use the \`/node\` entry point:

${nodeSnippet}

With \`registerProcessHandlers\` at its default (\`true\`), \`init()\` registers
listeners on \`uncaughtException\` and \`unhandledRejection\`. On an uncaught
exception the SDK captures and flushes (best effort, ~2 s cap) and — only if its
listener is the sole one — prints the stack and exits with code 1, exactly as
Node would. Set it to \`false\` to keep full control of the process lifecycle
(e.g. inside a test suite).

The Node entry also ships framework error middleware. Both **re-propagate** the
original error, so your app's own error handling stays intact:

${nodeMiddlewareSnippet}

\`captureError\`, \`createTicket\`, \`addBreadcrumb\` and \`flush\` work the same
in Node; \`captureFeedback\` in Node has no screenshot option (no DOM).

## Behavior & guarantees

- **Never breaks the host app.** With one intentional exception — \`init()\` with
  a **malformed DSN** throws immediately, because that's a configuration error
  that must surface at startup — nothing the SDK does ever propagates an
  exception into your code. A second \`init()\` is ignored with a warning and
  never duplicates listeners.
- **Batching & flush.** Events are queued and flushed on an interval
  (\`flushIntervalMs\`, default 3000 ms), plus at end of page in the browser. The
  queue is capped (oldest dropped past ~100 events), matching the server's batch
  limit.
- **Retry with backoff.** A failed batch (network error, \`429\`, or \`5xx\`) is
  retried with exponential backoff up to 3 attempts, then dropped. A \`4xx\`
  (e.g. \`401\`/\`422\`) is a configuration error and is dropped without retrying.
- \`flush()\` always resolves and **never rejects**.

## Verification steps

1. Deploy the change and load a tracked page (or start the Node service).
2. From the running app, trigger a test capture:

\`\`\`ts
import { captureError } from "@stubwise/sdk/browser"; // or "@stubwise/sdk/node"
captureError(new Error("Stubwise test error"));
\`\`\`

3. Within a few seconds (one flush interval) a new ticket with source
   **\`sdk_error\`** should appear in the **${projectName}** project in Stubwise.
   A thrown, uncaught error works too — it's captured automatically.

If nothing shows up, POST a smoke-test event straight to the ingestion endpoint
to isolate network/key issues from the SDK setup:

${verifyCurl}

A healthy response is a \`2xx\`. A \`401\` means the ingestion key is wrong for
this project's slug; a \`422\` means the event body doesn't match the schema.

## Security note

The ingestion key is **publishable**: it is meant to live in client-side code and
only allows *sending* events to this project — never reading its tickets (the
read APIs require authentication). It is **scoped to this one project**. Unlike
the customer-service widget (which has a key per widget), a project has exactly
**one ingestion key** shared by every site and service you instrument for it. If
it leaks, rotate it from the project's Integration settings in Stubwise.
`;
}
