import type * as Fake from "../../api";
import type { SearchResult } from "../../types";
import { appClient } from "./client";

// La ricerca di ⌘K nella build app (integrazione area 2, fetta 1): solo
// progetti e task (le aree non integrate non si cercano né si linkano). Le
// task da `GET /api/search`, che filtra già per visibilità; i progetti
// dall'elenco di chi guarda.

export const search: typeof Fake.search = async (q) => {
  const needle = q.trim();
  if (!needle) return [];
  const client = appClient();
  const [hits, rows] = await Promise.all([
    // `citable`: niente note di rilascio nel gruppo Docs (area 5, fetta 1).
    client.search.global(needle, undefined, { citable: true }),
    client.projects.list() as unknown as Promise<{ id: string; name: string; slug: string; code?: string }[]>,
  ]);
  const codeOf = new Map(rows.map((p) => [p.id, p.code ?? p.slug.toUpperCase()]));
  const lower = needle.toLowerCase();
  const results: SearchResult[] = [];
  for (const p of rows) {
    const code = codeOf.get(p.id)!;
    if (p.name.toLowerCase().includes(lower) || code.toLowerCase().includes(lower)) {
      results.push({ kind: "project", id: p.id, code, label: p.name, route: `#/p/${code}/tasks` });
    }
  }
  for (const t of hits.tickets.items) {
    const project = codeOf.get(t.projectId);
    if (!project) continue;
    const code = `${project}-${t.number}`;
    results.push({
      kind: "task",
      id: t.id,
      code,
      label: t.title,
      route: `#/p/${project}/tasks?task=${code}`,
    });
  }
  return results;
};
