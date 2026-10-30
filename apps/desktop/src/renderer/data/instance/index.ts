// L'istanza (area 9b) come la espone `api.ts`: `api.instance.<funzione>`.
// I Task 2–7 ci aggiungono le loro funzioni (consumi, AI, integrazioni,
// coda e Stato dell'istanza, repository). `changeTypes.ts` si importa per
// il suo effetto: registra i tipi di voce del registro prima della prima
// scrittura. Lo stato (`state.ts`) e il seme (`seed.ts`) non si esportano:
// li legge solo il livello dati.
import "./changeTypes";

export type { InstanceRefusal, InstanceResult } from "./types";
export type {
  AiProvider,
  AutomationRule,
  GitAccount,
  NightlyRow,
  OutgoingWebhook,
  QueuePause,
  RegisteredPlugin,
  StorageSettings,
  TestOutcome,
  UsageRecord,
} from "./state";
