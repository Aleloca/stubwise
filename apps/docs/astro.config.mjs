// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightOpenAPI, { openAPISidebarGroups } from "starlight-openapi";

// Servito da Caddy sotto /docs (handle_path /docs/* strippa il prefisso e
// serve la root statica): `base: "/docs"` fa sì che asset e link interni
// siano già prefissati con /docs, coerenti con il path esterno. Vedi
// Dockerfile.caddy e Caddyfile.
// DOCS_BASE/DOCS_SITE permettono deploy sotto un prefisso diverso, es.
// GitHub Pages serve il sito sotto /stubwise (vedi .github/workflows/docs.yml).
const base = process.env.DOCS_BASE ?? "/docs";

// I contenuti scrivono i link interni con il prefisso del deploy primario
// (/docs/...): quando il base è diverso vanno riscritti nell'HTML generato.
// I link della hero in frontmatter non passano da rehype: li gestisce il
// routeMiddleware (src/route-data.ts).
/** @typedef {{ properties?: Record<string, unknown>, children?: unknown[] }} RehypeNode */
function rehypeRebaseLinks() {
  /** @param {RehypeNode} node */
  const rebase = (node) => {
    const props = node.properties;
    if (props) {
      for (const key of ["href", "src"]) {
        const value = props[key];
        if (typeof value === "string" && (value === "/docs" || value.startsWith("/docs/"))) {
          props[key] = base + value.slice("/docs".length);
        }
      }
    }
    for (const child of node.children ?? []) {
      rebase(/** @type {RehypeNode} */ (child));
    }
  };
  return rebase;
}

export default defineConfig({
  base,
  markdown: {
    rehypePlugins: base === "/docs" ? [] : [rehypeRebaseLinks],
  },
  // Necessario per generare link assoluti corretti (es. canonical) ma non
  // vincola il deploy: i path restano relativi a `base`.
  site: process.env.DOCS_SITE ?? "https://stubwise.example.com",
  integrations: [
    starlight({
      routeMiddleware: "./src/route-data.ts",
      // Il titolo del sito è reso come wordmark di Stubwise (quadrato ambra +
      // "stubwise" mono + cursore lampeggiante): vedi SiteTitle.astro. `title`
      // resta per metadati/SEO (tab del browser, canonical, og:title).
      components: {
        SiteTitle: "./src/components/SiteTitle.astro",
      },
      title: "Stubwise",
      // Favicon condivisa con la web app: la "S_" ambra su quadrato scuro.
      // Starlight prefissa automaticamente con `base`. Il PNG (fallback per i
      // browser senza SVG) e l'apple-touch-icon vanno aggiunti a mano in head,
      // con il prefisso del base esplicito.
      favicon: "/favicon.svg",
      head: [
        {
          tag: "link",
          attrs: { rel: "icon", type: "image/png", sizes: "32x32", href: `${base}/favicon.png` },
        },
        {
          tag: "link",
          attrs: { rel: "apple-touch-icon", href: `${base}/apple-touch-icon.png` },
        },
      ],
      description:
        "Issue tracker self-hostabile con pipeline AI: dagli errori degli SDK ai ticket, fino alle pull request automatiche.",
      defaultLocale: "it",
      locales: {
        root: { label: "Italiano", lang: "it" },
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/Aleloca/stubwise",
        },
      ],
      plugins: [
        // Pagina di riferimento dell'API generata dalla spec OpenAPI del
        // server (src/openapi.json, prodotta dal prebuild gen:openapi).
        // base "reference/api" la annida nel gruppo Reference della sidebar.
        starlightOpenAPI([
          {
            base: "reference/api",
            label: "API HTTP",
            schema: "./src/openapi.json",
          },
        ]),
      ],
      sidebar: [
        {
          label: "Per iniziare",
          items: [
            { label: "Self-hosting", slug: "getting-started/self-hosting" },
            { label: "Auth del worker (Claude)", slug: "getting-started/claude-setup" },
            { label: "La web app", slug: "getting-started/web-app" },
          ],
        },
        {
          label: "SDK",
          items: [
            { label: "Installazione", slug: "sdk/installation" },
            { label: "Cattura degli errori", slug: "sdk/error-capture" },
            { label: "Feedback", slug: "sdk/feedback" },
            { label: "Ticket via API", slug: "sdk/api-tickets" },
          ],
        },
        {
          label: "Pipeline AI",
          items: [
            { label: "Come funziona", slug: "ai-pipeline/how-it-works" },
            { label: "Configurazione", slug: "ai-pipeline/configuration" },
            { label: "Sicurezza", slug: "ai-pipeline/security" },
          ],
        },
        {
          label: "Notifiche",
          items: [{ label: "Webhook in uscita", slug: "notifications" }],
        },
        {
          label: "Reference",
          items: [
            { label: "Variabili d'ambiente", slug: "reference/configuration" },
            ...openAPISidebarGroups,
          ],
        },
      ],
    }),
  ],
});
