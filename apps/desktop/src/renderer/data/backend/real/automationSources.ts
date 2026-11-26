import { ApiError } from "@stubwise/api-client";
import type {
  AutomationSource,
  AutomationSourceEvent,
  AutomationSourceView,
  ClientLinkView,
  ClientProjectLink,
  ClientSuggestion,
  DataField,
  FieldType,
  WebhookExamplePreview,
  WebhookSourceCreated,
} from "@stubwise/shared";
import { inPrototypeWords } from "./automationRefs";

// Le sorgenti e la tabella cliente → progetto della build app (area 7, F4,
// R4) sopra `client.automationSources` e `client.clientLinks`, con le firme
// del prototipo (`data/automations/{reads,webhooks,sourceWrites}.ts`). Nella
// F4 le sorgenti sono solo webhook (Q2). L'indirizzo intero col segreto lo
// compone il server ed esce SOLO dalla creazione e dalla rigenerazione
// (F4-1, C-F4-1): l'elenco non ce l'ha, e il client non scrive percorsi.

/** Le rotte che servono (sul client vero: `client.automationSources`, `client.clientLinks`). */
export interface SourcesApi {
  sources: {
    list(): Promise<{ items: AutomationSourceView[] }>;
    createWebhook(input: { name: string }): Promise<WebhookSourceCreated>;
    rename(id: string, input: { name: string }): Promise<AutomationSourceView>;
    regenerate(id: string): Promise<WebhookSourceCreated>;
    previewExample(id: string, json: string): Promise<WebhookExamplePreview>;
    setExample(id: string, json: string): Promise<AutomationSourceView>;
    updateField(
      id: string,
      key: string,
      patch: { label?: string; type?: FieldType },
    ): Promise<AutomationSourceView>;
    events(id: string): Promise<{ items: AutomationSourceEvent[] }>;
  };
  clientLinks: {
    list(): Promise<{ items: ClientLinkView[] }>;
    suggestions(): Promise<{ items: ClientSuggestion[] }>;
    put(
      clientKey: string,
      input: { clientName: string; projectId: string },
    ): Promise<ClientLinkView>;
    remove(clientKey: string): Promise<void>;
  };
}

/** Una lettura che un server senza la F4 (404) o un permesso mancante (403) non ha: niente. */
async function orNothing<T>(call: () => Promise<{ items: T[] }>): Promise<T[]> {
  try {
    return (await call()).items;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return [];
    throw error;
  }
}

export function createRealSources(api: SourcesApi) {
  return {
    listSources: (): Promise<AutomationSourceView[]> => orNothing(() => api.sources.list()),

    /** Il webhook nuovo, con l'indirizzo col segreto: si mostra adesso, poi non più. */
    async createWebhookSource(name: string): Promise<AutomationSource> {
      const { source, address } = await inPrototypeWords(() => api.sources.createWebhook({ name }));
      return { ...source, address };
    },

    async renameSource(id: string, name: string): Promise<void> {
      await inPrototypeWords(() => api.sources.rename(id, { name }));
    },

    /** L'indirizzo nuovo (il vecchio smette subito di funzionare): si mostra adesso, poi non più. */
    async regenerateWebhookAddress(id: string): Promise<string> {
      return (await inPrototypeWords(() => api.sources.regenerate(id))).address;
    },

    previewWebhookExample: (id: string, json: string): Promise<WebhookExamplePreview> =>
      inPrototypeWords(() => api.sources.previewExample(id, json)),

    async setWebhookExample(id: string, json: string): Promise<DataField[]> {
      return (await inPrototypeWords(() => api.sources.setExample(id, json))).fields;
    },

    async updateWebhookField(
      id: string,
      key: string,
      patch: { label?: string; type?: FieldType },
    ): Promise<void> {
      await inPrototypeWords(() => api.sources.updateField(id, key, patch));
    },

    /** Gli eventi recenti, coi rifiutati e il motivo (F4-5); solo a chi gestisce le integrazioni (F4-6). */
    listSourceEvents: (id: string): Promise<AutomationSourceEvent[]> =>
      orNothing(() => api.sources.events(id)),

    listClientLinks: (): Promise<ClientLinkView[]> => orNothing(() => api.clientLinks.list()),

    listClientSuggestions: (): Promise<ClientSuggestion[]> =>
      orNothing(() => api.clientLinks.suggestions()),

    /** La chiave la normalizza il server (`clientKeyOf`, e un CHECK sulla tabella). */
    async setClientLink(link: ClientProjectLink): Promise<void> {
      await inPrototypeWords(() =>
        api.clientLinks.put(link.clientKey, {
          clientName: link.clientName,
          projectId: link.projectId,
        }),
      );
    },

    async removeClientLink(clientKey: string): Promise<void> {
      await inPrototypeWords(() => api.clientLinks.remove(clientKey));
    },
  };
}
