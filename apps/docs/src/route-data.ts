/**
 * The hero action links (index.mdx frontmatter) don't pass through the rehype
 * pipeline, so rebasing the internal /docs/... links toward the actual base
 * (/guide behind Caddy, /stubwise on GitHub Pages) must be done here, on the
 * route data. Mirrors rehypeRebaseLinks in astro.config.mjs: the content
 * convention is `/docs/...` (PRIMARY_BASE), the default deploy base is /guide.
 */
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

const PRIMARY_BASE = "/docs";
const base = process.env.DOCS_BASE ?? "/guide";

/**
 * D6 of the old web retirement (R1): the guide still describes the old web
 * app, and is rewritten on the new app right after the switch. Until then
 * every page says so, from one place. Remove this when the rewrite lands.
 */
export const REWRITE_NOTICE =
  "This guide still describes the previous web app, which has been replaced by the new Stubwise app. It is being rewritten: some screens, names and paths may differ from what you see.";

export const onRequest = defineRouteMiddleware(({ locals }) => {
  const data = locals.starlightRoute.entry.data;
  data.banner ??= { content: REWRITE_NOTICE };
  if (base === PRIMARY_BASE) return;
  const { hero } = data;
  for (const action of hero?.actions ?? []) {
    if (action.link === PRIMARY_BASE || action.link?.startsWith(`${PRIMARY_BASE}/`)) {
      action.link = base + action.link.slice(PRIMARY_BASE.length);
    }
  }
});
