import { ApiError } from "@stubwise/api-client";
import type {
  Reader,
  WidgetAdmin,
  WidgetIdentitySecretResult,
  WidgetUpsertInput,
} from "@stubwise/shared";
import type { SupportWidgetView, WidgetInput, WidgetList } from "../../support";
import type { SupportWidget } from "../../model";
import { asPrototypeError, inPrototypeWords } from "./automationRefs";
import { appClient } from "./client";

// I widget di Support nella build app (area 8, F3, R1/R2) sulle rotte di oggi
// (quelle del web, `client.widgets`), con le firme del prototipo. Il server
// chiama le cose coi nomi del web (`enabledRepositoryIds`, `dailyTicketCap`,
// `repositoryFilters`). La PUT è una SOSTITUZIONE: si manda il corpo intero, coi
// filtri dei repository di prima (limitati a quelli ancora accesi, o 422).
// L'unica eccezione sono i siti ammessi (`origins`, area 8 F3 S16): assenti
// dal corpo, il server li tiene com'erano; si mandano solo quando cambiano.

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
  /** API per i siti (S6): +R e `widget.manage`; il segreto esce solo qui. */
  regenerateIdentitySecret(
    projectId: string,
    widgetId: string,
  ): Promise<Reader<WidgetIdentitySecretResult>>;
}

/** Il widget nella forma del prototipo, con la chiave e l'origine per lo snippet. */
function viewOf(projectId: string, w: Reader<WidgetAdmin>, origin: string): SupportWidgetView {
  return {
    id: w.id,
    projectId,
    name: w.name,
    enabled: w.enabled,
    sourceRepositoryIds: [...w.enabledRepositoryIds],
    // Un server di prima di S16 non li manda: il default è l'elenco vuoto.
    origins: [...w.origins],
    title: w.title,
    welcomeMessage: w.welcomeMessage,
    instructions: w.instructions,
    accentColor: w.accentColor,
    language: w.language === "en" ? "en" : "it",
    dailyMessageCap: w.dailyMessageCap,
    dailyRequestCap: w.dailyTicketCap,
    // API per i siti (S6): un server di prima non li manda, i default dello schema.
    identitySecretSet: w.identitySecretSet,
    identitySecretRotatedAt: w.identitySecretRotatedAt,
    identityRequired: w.identityRequired,
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
    ...(patch.origins !== undefined ? { origins: [...patch.origins] } : {}),
    // Facoltativo sul server: assente resta com'era.
    ...(patch.identityRequired !== undefined ? { identityRequired: patch.identityRequired } : {}),
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

/** Il 422 del toggle senza segreto è l'errore del campo, come nel prototipo. */
async function widgetWrite<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ApiError && error.code === "identity_secret_missing") {
      throw new Error("invalid: identityRequired");
    }
    throw error;
  }
}

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
      const { widget } = await inPrototypeWords(() =>
        widgetWrite(() => api.create(projectId, bodyOf(null, input))),
      );
      known.set(widget.id, { projectId, widget });
      return viewOf(projectId, widget, await instanceOrigin());
    },

    async updateWidget(id: string, patch: Partial<SupportWidget>): Promise<SupportWidget> {
      const before = known.get(id);
      if (!before) throw notFound();
      const { widget } = await inPrototypeWords(() =>
        widgetWrite(() => api.update(before.projectId, id, bodyOf(before.widget, patch))),
      );
      known.set(id, { projectId: before.projectId, widget });
      return viewOf(before.projectId, widget, await instanceOrigin());
    },

    async regenerateIdentitySecret(
      id: string,
    ): Promise<
      { ok: true; secret: string; rotatedAt: string } | { ok: false; error: "reauth_required" }
    > {
      const before = known.get(id);
      if (!before) throw notFound();
      try {
        const r = await api.regenerateIdentitySecret(before.projectId, id);
        return { ok: true, secret: r.secret, rotatedAt: r.rotatedAt };
      } catch (error) {
        if (error instanceof ApiError && error.code === "reauth_required") {
          return { ok: false, error: "reauth_required" };
        }
        throw asPrototypeError(error);
      }
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
export async function instanceOrigin(): Promise<string> {
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
    regenerateIdentitySecret: (projectId, widgetId) =>
      appClient().widgets.regenerateIdentitySecret(projectId, widgetId),
  },
  instanceOrigin,
);
