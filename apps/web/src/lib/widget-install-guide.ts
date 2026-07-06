import type { Widget } from "./api";

/**
 * Costruisce il DSN di un widget: `<protocol>//<key>@<host>/p/<slug>`. Il
 * protocol/host derivano dall'origin (così http locale resta http). La chiave è
 * quella DEL WIDGET (non la ingestionKey del progetto). Unica sorgente di verità
 * della costruzione DSN, condivisa da snippet dell'editor e guida di install.
 */
export function buildWidgetDsn(key: string, slug: string, origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${key}@${url.host}/p/${slug}`;
}

/** Slug filesystem-safe per il nome file della guida scaricata. */
function toFileSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "widget"
  );
}

/** Nome file suggerito per il download della guida di un widget. */
export function widgetGuideFilename(widgetName: string): string {
  return `stubwise-widget-${toFileSlug(widgetName)}.md`;
}

interface WidgetInstallGuideInput {
  widget: Widget;
  projectSlug: string;
  projectName: string;
  /** Origin dell'istanza Stubwise (es. `window.location.origin`). */
  origin: string;
}

/**
 * Genera un documento markdown AUTOCONTENUTO per installare QUESTO widget su un
 * sito di destinazione. È scritto per essere incollato a un agent AI: contiene
 * tutti i valori REALI (DSN, chiave, URL del bundle e della guida) e nessuna
 * fonte esterna richiesta. Funzione PURA (nessun DOM): testabile in isolamento.
 *
 * Il CONTENUTO è in inglese di proposito — è un documento tecnico destinato a un
 * agent, non UI localizzata. Gli unici placeholder sono i campi del parametro
 * `user`, che il sito ospite riempie con l'identità dell'utente loggato.
 */
export function buildWidgetInstallGuide(input: WidgetInstallGuideInput): string {
  const { widget, projectSlug, projectName, origin } = input;
  const dsn = buildWidgetDsn(widget.key, projectSlug, origin);
  const bundleUrl = `${origin}/widget.js`;
  const guideUrl = `${origin}/guide/integrations/widget/`;
  const configUrl = `${origin}/widget/${projectSlug}/config`;

  const scriptSnippet = [
    "```html",
    `<script src="${bundleUrl}" defer></script>`,
    "<script>",
    '  window.addEventListener("stubwise:ready", function () {',
    "    Stubwise.initWidget({",
    `      dsn: "${dsn}",`,
    '      user: { id: "REPLACE_USER_ID", email: "REPLACE_EMAIL", name: "REPLACE_NAME" },',
    "    });",
    "  });",
    "</script>",
    "```",
  ].join("\n");

  const npmSnippet = [
    "```js",
    'import { initWidget } from "@stubwise/widget";',
    "",
    "initWidget({",
    `  dsn: "${dsn}",`,
    '  user: { id: "REPLACE_USER_ID", email: "REPLACE_EMAIL", name: "REPLACE_NAME" },',
    "});",
    "```",
  ].join("\n");

  return `# Install the "${widget.name}" support widget

This installs a Stubwise customer-service widget on a target website: a
docs-grounded chat assistant plus a form that turns bug reports and feedback
into tickets. Everything you need is in this document — no other sources
required.

## Key facts

- Stubwise instance URL: ${origin}
- Project name: ${projectName}
- Project slug: ${projectSlug}
- Widget name: ${widget.name}
- Widget id: ${widget.id}
- Widget key (publishable): ${widget.key}
- DSN (connects the widget to this project): ${dsn}
- Bundle URL (script tag): ${bundleUrl}
- User guide (reference only): ${guideUrl}

## Option A — script tag (any website, no build step)

Add this to the page(s) where the widget should appear. Loading \`/widget.js\`
publishes \`window.Stubwise\` and fires the \`stubwise:ready\` event; initialize
inside that listener so \`Stubwise.initWidget\` is guaranteed to exist.

${scriptSnippet}

## Option B — npm (bundler / framework)

${npmSnippet}

Install the package first:

\`\`\`sh
npm install @stubwise/widget
\`\`\`

Importing the package also publishes \`window.Stubwise\` and fires
\`stubwise:ready\` as a side effect, but with a bundler you can call
\`initWidget\` directly.

## The \`user\` parameter

- \`user.id\` is **required**: a stable identifier for the host site's logged-in
  user (e.g. your internal user id). It ties conversations and tickets to a
  person across sessions.
- \`user.email\` and \`user.name\` are **optional** and only improve attribution
  and reply routing.

The identity is **declared by the host site and never verified** by Stubwise.
For trustworthy attribution, only initialize the widget inside authenticated
areas where you already know who the user is.

## Placement & behavior notes

- Put the script on every page where assistance should be available. In most
  apps that means a shared layout/template so it loads once, everywhere.
- The widget mounts a chat bubble in the **bottom-right** corner, isolated
  inside a **Shadow DOM**, so it cannot clash with the host page's styles.
- It is built to **never** break the host site: on any error (bad DSN, network
  failure, disabled widget) the widget simply does not appear.
- Calling \`initWidget\` twice is a **no-op** — a duplicate init won't mount a
  second bubble.
- No third-party cookies and no cross-site tracking.

## Verification steps

1. Deploy the change and open a page that includes the script.
2. Confirm the chat bubble appears in the bottom-right corner.
3. In the browser console, check that \`window.Stubwise\` is defined.
4. If the bubble does not appear:
   - Make sure the widget is **enabled** in its Stubwise settings.
   - The config endpoint must report it as enabled:

\`\`\`sh
curl -H "X-Stubwise-Key: ${widget.key}" ${configUrl}
\`\`\`

     A healthy response looks like \`{"enabled":true, ...}\`. If it returns
     \`{"enabled":false}\` the widget is disabled; a \`401\` means the key is
     wrong for this project's slug.

## Security note

The widget key is **publishable**: it is meant to live in the page source. It
identifies only this one widget and grants nothing else. If it leaks, you can
**revoke** it by deleting this widget in Stubwise (which invalidates the key).
`;
}
