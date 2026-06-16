// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightOpenAPI, { openAPISidebarGroups } from "starlight-openapi";

// Served by Caddy under /docs (handle_path /docs/* strips the prefix and
// serves the static root): `base: "/docs"` makes assets and internal links
// already prefixed with /docs, consistent with the external path. See
// Dockerfile.caddy and Caddyfile.
// DOCS_BASE/DOCS_SITE allow deploying under a different prefix, e.g.
// GitHub Pages serves the site under /stubwise (see .github/workflows/docs.yml).
const base = process.env.DOCS_BASE ?? "/docs";

// The content writes internal links with the primary deploy's prefix
// (/docs/...): when the base is different they must be rewritten in the
// generated HTML. The hero links in frontmatter don't pass through rehype: the
// routeMiddleware (src/route-data.ts) handles them.
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
  // Needed to generate correct absolute links (e.g. canonical) but doesn't
  // constrain the deploy: the paths stay relative to `base`.
  site: process.env.DOCS_SITE ?? "https://stubwise.example.com",
  integrations: [
    starlight({
      routeMiddleware: "./src/route-data.ts",
      // The site title is rendered as the Stubwise wordmark (amber square +
      // "stubwise" mono + blinking cursor): see SiteTitle.astro. `title`
      // stays for metadata/SEO (browser tab, canonical, og:title).
      components: {
        SiteTitle: "./src/components/SiteTitle.astro",
      },
      title: "Stubwise",
      // Favicon shared with the web app: the amber "S_" on a dark square.
      // Starlight automatically prefixes with `base`. The PNG (fallback for
      // browsers without SVG) and the apple-touch-icon must be added by hand in
      // head, with the explicit base prefix.
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
        "Self-hostable issue tracker with an AI pipeline: from SDK errors to tickets, all the way to automatic pull requests.",
      defaultLocale: "en",
      locales: {
        root: { label: "English", lang: "en" },
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/Aleloca/stubwise",
        },
      ],
      plugins: [
        // API reference page generated from the server's OpenAPI spec
        // (src/openapi.json, produced by the gen:openapi prebuild).
        // base "reference/api" nests it in the sidebar's Reference group.
        starlightOpenAPI([
          {
            base: "reference/api",
            label: "HTTP API",
            schema: "./src/openapi.json",
          },
        ]),
      ],
      sidebar: [
        {
          label: "Getting started",
          items: [
            { label: "Self-hosting", slug: "getting-started/self-hosting" },
            { label: "Worker auth (Claude)", slug: "getting-started/claude-setup" },
            { label: "The web app", slug: "getting-started/web-app" },
          ],
        },
        {
          label: "SDK",
          items: [
            { label: "Installation", slug: "sdk/installation" },
            { label: "Error capture", slug: "sdk/error-capture" },
            { label: "Feedback", slug: "sdk/feedback" },
            { label: "Tickets via API", slug: "sdk/api-tickets" },
          ],
        },
        {
          label: "AI pipeline",
          items: [
            { label: "How it works", slug: "ai-pipeline/how-it-works" },
            { label: "Automation", slug: "ai-pipeline/automation" },
            { label: "Configuration", slug: "ai-pipeline/configuration" },
            { label: "Security", slug: "ai-pipeline/security" },
          ],
        },
        {
          label: "Notifications",
          items: [{ label: "Outgoing webhook", slug: "notifications" }],
        },
        {
          label: "Reference",
          items: [
            { label: "Environment variables", slug: "reference/configuration" },
            ...openAPISidebarGroups,
          ],
        },
      ],
    }),
  ],
});
