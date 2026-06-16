/**
 * The hero action links (index.mdx frontmatter) don't pass through the rehype
 * pipeline, so rebasing the internal /docs/... links toward a different base
 * (e.g. /stubwise on GitHub Pages) must be done here, on the route data.
 * Mirrors rehypeRebaseLinks in astro.config.mjs.
 */
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

const PRIMARY_BASE = "/docs";
const base = process.env.DOCS_BASE ?? PRIMARY_BASE;

export const onRequest = defineRouteMiddleware(({ locals }) => {
  if (base === PRIMARY_BASE) return;
  const { hero } = locals.starlightRoute.entry.data;
  for (const action of hero?.actions ?? []) {
    if (action.link === PRIMARY_BASE || action.link?.startsWith(`${PRIMARY_BASE}/`)) {
      action.link = base + action.link.slice(PRIMARY_BASE.length);
    }
  }
});
