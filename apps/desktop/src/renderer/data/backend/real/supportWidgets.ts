import type { Reader, WidgetAdmin, WidgetUpsertInput } from "@stubwise/shared";
import type { SupportWidgetView, WidgetInput, WidgetList } from "../../support";
import type { SupportWidget } from "../../model";
import { inPrototypeWords } from "./automationRefs";
import { appClient } from "./client";

// I widget di Support nella build app (area 8, F3, R1/R2) sulle rotte di oggi
// (quelle del web, `client.widgets`), con le firme del prototipo. Il server
// chiama le cose coi nomi del web (`enabledRepositoryIds`, `dailyTicketCap`,
// `repositoryFilters`) e non ha i «siti ammessi» (`origins`): nell'app quel
// campo non c'è. La PUT è una SOSTITUZIONE: si manda il corpo intero, coi
// filtri dei repository di prima (limitati a quelli ancora accesi, o 422).

/** Le rotte (sul client vero: `client.widgets`). */
export interface WidgetsApi {
  list(projectId: string): Promise<Reader<{ widgets: WidgetAdmin[]; canManage: boolean }>>;
  create(projectId: string, body: WidgetUpsertInput): Promise<Reader<{ widget: WidgetAdmin }>>;
  update(
    projectId: string,
    widgetId: string,
    body: WidgetUpsertInput,
  ): Promise<Reader<{ widget: WidgetAdmin }>>;
  remove(projectId: string, widgetId: string): Promise<void>;
}

/** Il widget nella forma del prototipo, con la chiave e l'origine per lo snippet. */
function viewOf(projectId: string, w: Reader<WidgetAdmin>, origin: string): SupportWidgetView {
  return {
    id: w.id,
    projectId,
    name: w.name,
    enabled: w.enabled,
    sourceRepositoryIds: [...w.enabledRepositoryIds],
    // Il server non ha i siti ammessi: nell'app il campo non si mostra.
    origins: [],
    title: w.title,
    welcomeMessage: w.welcomeMessage,
    instructions: w.instructions,
    accentColor: w.accentColor,
    language: w.language === "en" ? "en" : "it",
    dailyMessageCap: w.dailyMessageCap,
    dailyRequestCap: w.dailyTicketCap,
    createdAt: w.createdAt,
    conversationCount: w.conversationCount,
    key: w.key,
    snippetOrigin: origin,
  };
}

/** Il corpo del server: il widget di prima, con la modifica sopra. */
function bodyOf(
  before: Reader<WidgetAdmin> | null,
  patch: Partial<SupportWidget>,
): WidgetUpsertInput {
  const enabledRepositoryIds = patch.sourceRepositoryIds ?? [
    ...(before?.enabledRepositoryIds ?? []),
  ];
  const filters = before?.repositoryFilters ?? {};
  return {
    name: patch.name ?? before?.name ?? "",
    enabled: patch.enabled ?? before?.enabled ?? false,
    enabledRepositoryIds,
    // Solo i filtri dei repository ancora accesi: gli altri il server li rifiuta
    // (422). Un `kind` che l'app non conosce (un server più nuovo) è già
    // `__unknown__` alla lettura: non si può rimandare com'era, e si toglie.
    repositoryFilters: Object.fromEntries(
      Object.entries(filters)
        .filter(([id]) => enabledRepositoryIds.includes(id))
        .map(([id, f]) => [id, { ...f, kinds: f.kinds.filter((k) => k !== "__unknown__") }]),
    ) as WidgetUpsertInput["repositoryFilters"],
    ...((patch.title ?? before?.title) ? { title: patch.title ?? before!.title } : {}),
    ...((patch.welcomeMessage ?? before?.welcomeMessage)
      ? { welcomeMessage: patch.welcomeMessage ?? before!.welcomeMessage }
      : {}),
    instructions: patch.instructions ?? before?.instructions ?? "",
    ...((patch.accentColor ?? before?.accentColor)
      ? { accentColor: patch.accentColor ?? before!.accentColor }
      : {}),
    ...((patch.language ?? before?.language)
      ? { language: (patch.language ?? before!.language) as WidgetUpsertInput["language"] }
      : {}),
    dailyMessageCap:
      patch.dailyMessageCap !== undefined
        ? patch.dailyMessageCap
        : (before?.dailyMessageCap ?? null),
    dailyTicketCap:
      patch.dailyRequestCap !== undefined
        ? patch.dailyRequestCap
        : (before?.dailyTicketCap ?? null),
  };
}

const notFound = () => new Error("not_found");

export function createRealWidgets(api: WidgetsApi, instanceOrigin: () => Promise<string>) {
  /** L'ultimo widget letto, col suo progetto: la PUT vuole il corpo intero e il progetto. */
  const known = new Map<string, { projectId: string; widget: Reader<WidgetAdmin> }>();

  return {
    async listWidgets(projectId: string): Promise<WidgetList> {
      const [{ widgets, canManage }, origin] = await inPrototypeWords(() =>
        Promise.all([api.list(projectId), instanceOrigin()]),
      );
      for (const w of widgets) known.set(w.id, { projectId, widget: w });
      // Come nel prototipo: senza `widget.manage` la sezione non c'è.
      if (!canManage) return { canManage: false, widgets: [] };
      return { canManage: true, widgets: widgets.map((w) => viewOf(projectId, w, origin)) };
    },

    async createWidget(projectId: string, input: WidgetInput): Promise<SupportWidget> {
      const { widget } = await inPrototypeWords(() => api.create(projectId, bodyOf(null, input)));
      known.set(widget.id, { projectId, widget });
      return viewOf(projectId, widget, await instanceOrigin());
    },

    async updateWidget(id: string, patch: Partial<SupportWidget>): Promise<SupportWidget> {
      const before = known.get(id);
      if (!before) throw notFound();
      const { widget } = await inPrototypeWords(() =>
        api.update(before.projectId, id, bodyOf(before.widget, patch)),
      );
      known.set(id, { projectId: before.projectId, widget });
      return viewOf(before.projectId, widget, await instanceOrigin());
    },

    async deleteWidget(id: string): Promise<void> {
      const before = known.get(id);
      if (!before) throw notFound();
      await inPrototypeWords(() => api.remove(before.projectId, id));
      known.delete(id);
    },
  };
}

/** L'indirizzo dell'istanza, per lo snippet: quella scelta sul desktop, o questa pagina nel browser. */
async function instanceOrigin(): Promise<string> {
  const chosen = await window.stubwise?.instance?.get?.().catch(() => null);
  if (chosen) {
    try {
      return new URL(chosen).origin;
    } catch {
      /* un indirizzo malformato: quello della pagina */
    }
  }
  return window.location.origin;
}

/** Sul client vero (il client si legge a ogni chiamata). */
export const liveWidgets = createRealWidgets(
  {
    list: (projectId) => appClient().widgets.list(projectId),
    create: (projectId, body) => appClient().widgets.create(projectId, body),
    update: (projectId, widgetId, body) => appClient().widgets.update(projectId, widgetId, body),
    remove: (projectId, widgetId) => appClient().widgets.delete(projectId, widgetId),
  },
  instanceOrigin,
);
