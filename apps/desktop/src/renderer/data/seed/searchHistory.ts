import type { DocPage, DocSpace, Task } from "../model";
import type { SearchHistoryEntry } from "../searchHistoryModel";

// I risultati aperti di recente nella ⌘K (shape `search-history.md` §6): tre
// voci di Laura in STW, una task, il progetto e una pagina Docs, così la ⌘K a
// query vuota li mostra subito. Le altre persone partono vuote. Si calcolano
// dal resto del seme (la prima task e la prima pagina di STW), invece di
// ripeterne id e slug.

export function seedSearchHistory(tasks: Task[], pages: DocPage[], spaces: DocSpace[]): SearchHistoryEntry[] {
  const task = tasks.find((t) => t.projectId === "prj-stw");
  const space = spaces.find((s) => s.projectId === "prj-stw");
  const page = space ? pages.find((p) => p.repositoryId === space.repositoryId) : undefined;
  const entries: SearchHistoryEntry[] = [];
  if (task)
    entries.push({
      personId: "p-laura",
      type: "ticket",
      entityId: task.id,
      title: task.title,
      subtitle: task.code,
      route: `#/p/STW/tasks?task=${task.code}`,
      repositoryId: null,
      clickedAt: "2026-10-20T09:12:00Z",
    });
  entries.push({
    personId: "p-laura",
    type: "project",
    entityId: "prj-stw",
    title: "Stubwise",
    subtitle: "STW",
    route: "#/p/STW/tasks",
    repositoryId: null,
    clickedAt: "2026-10-19T16:40:00Z",
  });
  if (page && space)
    entries.push({
      personId: "p-laura",
      type: "doc",
      entityId: `${space.repositoryId}:${page.slug}`,
      title: page.title,
      subtitle: page.code,
      route: `#/p/STW/docs/${space.name}/${page.slug}`,
      repositoryId: space.repositoryId,
      clickedAt: "2026-10-18T11:05:00Z",
    });
  return entries;
}
