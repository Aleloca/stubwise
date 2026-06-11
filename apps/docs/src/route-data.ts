/**
 * I link delle azioni della hero (frontmatter di index.mdx) non passano dalla
 * pipeline rehype, quindi il rebase dei link interni /docs/... verso un base
 * diverso (es. /stubwise su GitHub Pages) va fatto qui, sui dati di route.
 * Specchia rehypeRebaseLinks in astro.config.mjs.
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
