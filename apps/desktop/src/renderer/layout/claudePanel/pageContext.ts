import type { CodedContextKind } from "../../data/api";
import { TASK_CODE_RE } from "../../data/routes";
import type { ContextRef } from "../../data/types";

// Il contesto del riquadro di Claude ricavato dall'indirizzo (area 10a, Task
// 8, shape claude-panel.md «Il chip del contesto»). Funzioni pure: chi le
// chiama passa il modo di risolvere i codici in id (`PageLookup`), letto dal
// livello dati con la visibilità di chi guarda. Un codice che non si risolve
// — invisibile, inesistente, non ancora letto — non dà contesto: il chip
// manca, senza una frase al suo posto (R-G5).

/** Dai codici dell'indirizzo agli id del riferimento; `null` = chi guarda non lo vede. */
export interface PageLookup {
  projectIdOf(code: string): string | null;
  /** Gli oggetti che l'indirizzo nomina col codice (`?task=ACQ-3`, `/automations/AUD-A1`). */
  objectIdOf?(kind: CodedContextKind, code: string): string | null;
}

export interface PageLocation {
  pathname: string;
  search: Record<string, unknown>;
}

const PROJECT_PATH = /^\/p\/([A-Za-z]{2,4})(?:\/([^/]+))?(?:\/([^/]+))?/;

/** Il valore di un parametro, solo se è una stringa non vuota. */
const param = (search: Record<string, unknown>, key: string): string | null => {
  const v = search[key];
  return typeof v === "string" && v.length > 0 ? v : null;
};

/** L'oggetto che l'indirizzo nomina col codice, da risolvere in id; `null` se non ce n'è. */
export function pageObjectOf(
  location: PageLocation,
): { kind: CodedContextKind; code: string } | null {
  const task = param(location.search, "task");
  if (task && TASK_CODE_RE.test(task)) return { kind: "task", code: task };
  const p = PROJECT_PATH.exec(location.pathname);
  if (p) {
    if (p[2] === "releases" && p[3]) return { kind: "release", code: p[3].toUpperCase() };
    if (p[2] === "support" && p[3]) return { kind: "support", code: p[3].toUpperCase() };
    return null;
  }
  const automation = /^\/automations\/([^/]+)/.exec(location.pathname)?.[1];
  if (automation && automation !== "sources") return { kind: "automation", code: automation };
  return null;
}

/**
 * Ciò che chi guarda ha davanti, come riferimento: l'oggetto aperto (task
 * nel pannello, richiesta, PR, rilascio, conversazione di supporto,
 * automazione), una voce di Settings, o la pagina. `null` se l'oggetto o il
 * progetto non si risolvono.
 */
export function pageContextOf(location: PageLocation, lookup: PageLookup): ContextRef | null {
  const { pathname, search } = location;
  const object = pageObjectOf(location);
  if (object) {
    const id = lookup.objectIdOf?.(object.kind, object.code) ?? null;
    if (id === null) return null;
    switch (object.kind) {
      case "task":
        return { kind: "task", taskId: id };
      case "release":
        return { kind: "release", releaseId: id };
      case "support":
        return { kind: "support", conversationId: id };
      case "automation":
        return { kind: "automation", automationId: id };
    }
  }

  const p = PROJECT_PATH.exec(pathname);
  if (p) {
    const projectId = lookup.projectIdOf(p[1]!.toUpperCase());
    if (projectId === null) return null;
    const section = p[2] ?? "overview";
    const request = param(search, "request");
    if (section === "requests" && request) return { kind: "request", requestId: request };
    const pr = param(search, "pr");
    if (section === "releases" && pr) return { kind: "pr", prId: pr };
    if (section === "settings") return { kind: "settings", projectId, section: p[3] ?? "general" };
    return { kind: "page", route: section, projectId };
  }

  const admin = /^\/admin\/([^/]+)/.exec(pathname)?.[1];
  if (admin) {
    const tab = param(search, "tab");
    return {
      kind: "settings",
      projectId: null,
      section: admin === "ai" && tab ? `ai.${tab}` : admin,
    };
  }

  // La Posta (area 10b, D1): la conversazione aperta o l'email nuova. Se chi
  // guarda la vede lo dice `describeContext` (`mailbox_owner`), come per una PR.
  const thread = /^\/mail\/([^/]+)/.exec(pathname)?.[1];
  if (thread) return { kind: "mail", threadId: thread };
  if (/^\/mail\/?$/.test(pathname) && param(search, "compose") === "new") {
    return { kind: "mail", threadId: null };
  }

  const route = /^\/([^/]+)/.exec(pathname)?.[1] ?? "home";
  return { kind: "page", route, projectId: null };
}
