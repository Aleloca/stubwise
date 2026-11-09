import type { SupportWidget } from "../../data/types";

// Lo snippet e la guida d'installazione di un widget (shape support.md §6),
// nella forma del web (`apps/web/src/components/widgets-section.tsx`,
// `widget-install-guide.ts`). Nel prototipo l'istanza è finta e il DSN porta
// l'id del widget al posto della sua chiave: nessun indirizzo vero.

const ORIGIN = "https://stubwise.example.com";

const dsnOf = (w: Pick<SupportWidget, "id" | "projectId">) =>
  `${ORIGIN}/widget/${w.projectId}?key=${w.id}`;

export function widgetSnippet(w: Pick<SupportWidget, "id" | "projectId">): string {
  return [
    `<script src="${ORIGIN}/widget.js" defer></script>`,
    "<script>",
    '  window.addEventListener("stubwise:ready", function () {',
    "    Stubwise.initWidget({",
    `      dsn: "${dsnOf(w)}",`,
    '      user: { id: "USER_ID", email: "USER_EMAIL", name: "USER_NAME" },',
    "    });",
    "  });",
    "</script>",
  ].join("\n");
}

/** Il nome del file della guida: `stubwise-widget-<nome>.md`. */
export function widgetGuideFile(w: Pick<SupportWidget, "name">): string {
  const slug = w.name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `stubwise-widget-${slug || "widget"}.md`;
}

/**
 * La guida autocontenuta, in inglese come sul web: è un documento tecnico da
 * incollare a chi installa (o a un agente), non testo dell'interfaccia.
 */
export function widgetGuide(w: SupportWidget): string {
  const name = w.name.replace(/\s*\n+\s*/g, " ");
  return [
    `# Install the Stubwise widget "${name}"`,
    "",
    "Add this snippet before the closing `</body>` tag of every page where the widget should appear.",
    "",
    "```html",
    widgetSnippet(w),
    "```",
    "",
    "Replace `USER_ID`, `USER_EMAIL` and `USER_NAME` with the signed-in user's identity, or remove `user` for anonymous visitors.",
    "",
    "## Key facts",
    "",
    `- DSN: \`${dsnOf(w)}\``,
    `- Allowed sites: ${w.origins.length ? w.origins.map((o) => `\`${o}\``).join(", ") : "none yet"}`,
    `- Language: ${w.language === "it" ? "Italian" : "English"}`,
    `- Status: ${w.enabled ? "on" : "off (it accepts no new conversations)"}`,
    "",
  ].join("\n");
}
