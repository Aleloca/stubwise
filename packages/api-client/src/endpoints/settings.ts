import {
  createOutgoingWebhookSchema,
  modelSettingsViewSchema,
  outgoingWebhookPreviewSchema,
  outgoingWebhookTestResultSchema,
  outgoingWebhookViewSchema,
  outgoingWebhookWithSecretSchema,
} from "@stubwise/shared";
import type {
  AiModelChoice,
  AiOperation,
  ModelSettingsView,
  OutgoingWebhookEvent,
  OutgoingWebhookView,
  OutgoingWebhookWithSecret,
  Reader,
  UpdateOutgoingWebhookInput,
} from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg, toQuery } from "../query.js";

/**
 * Area 9, F3: i webhook in uscita (`/api/settings/webhooks`, chi gestisce le
 * integrazioni). Il segreto esce SOLO dalla creazione e dalla rigenerazione
 * (`OutgoingWebhookWithSecret`), una volta: le letture dicono `secretSet`.
 * Creare, rigenerare ed eliminare chiedono la riconferma.
 */
export function createWebhookEndpoints(request: ApiRequest) {
  return {
    list(): Promise<Reader<OutgoingWebhookView>[]> {
      return request("GET", "/api/settings/webhooks", undefined, z.array(outgoingWebhookViewSchema));
    },
    create(input: z.input<typeof createOutgoingWebhookSchema>): Promise<Reader<OutgoingWebhookWithSecret>> {
      return request("POST", "/api/settings/webhooks", input, outgoingWebhookWithSecretSchema);
    },
    /** Una patch: i campi assenti restano. */
    update(id: string, patch: UpdateOutgoingWebhookInput): Promise<Reader<OutgoingWebhookView>> {
      return request("PATCH", `/api/settings/webhooks/${seg(id)}`, patch, outgoingWebhookViewSchema);
    },
    rotateSecret(id: string): Promise<Reader<OutgoingWebhookWithSecret>> {
      return request("POST", `/api/settings/webhooks/${seg(id)}/secret`, undefined, outgoingWebhookWithSecretSchema);
    },
    remove(id: string): Promise<void> {
      return request("DELETE", `/api/settings/webhooks/${seg(id)}`);
    },
    test(id: string) {
      return request("POST", `/api/settings/webhooks/${seg(id)}/test`, undefined, outgoingWebhookTestResultSchema);
    },
    preview(format: "slack" | "discord" | "generic", event: OutgoingWebhookEvent) {
      return request("GET", `/api/settings/webhooks/preview${toQuery({ format, event })}`, undefined, outgoingWebhookPreviewSchema);
    },
  };
}

/** Area 9, F3: i modelli per operazione, con la fonte (`source`). */
export function createSettingsEndpoints(request: ApiRequest) {
  return {
    models(): Promise<Reader<ModelSettingsView>> {
      return request("GET", "/api/settings/models", undefined, modelSettingsViewSchema);
    },
    /** `null` torna al default (l'env del worker o il default di codice). */
    setModels(models: Partial<Record<AiOperation, AiModelChoice | null>>): Promise<Reader<ModelSettingsView>> {
      return request("PATCH", "/api/settings/models", { models }, modelSettingsViewSchema);
    },
  };
}
