import type { FastifyInstance } from "fastify";
import {
  createSlackClient,
  loadSlackCreds as loadSlackCredsFromDb,
  type SlackClientFactory,
  type SlackCreds,
} from "@stubwise/notifications";

/**
 * Accesso alle credenziali Slack dal contesto Fastify.
 *
 * Il caricamento vero (query + decifratura) vive in `@stubwise/notifications`
 * insieme al client, perché serve anche al worker; qui resta la sola forma
 * comoda per le rotte, che hanno l'`instance` sotto mano. `SlackClientFactory`
 * e `SlackCreds` sono ri-esportati per non cambiare gli import esistenti.
 */
export type { SlackClientFactory, SlackCreds };

/**
 * Carica e decifra signing secret + bot token dalle instance settings
 * (singleton id=1). Ritorna null se uno dei due manca (integrazione non
 * completa) o se la decifratura fallisce (blob corrotto/chiave errata): in
 * entrambi i casi il flusso Slack è trattato come "non abilitato". I segreti
 * non vengono mai loggati.
 */
export async function loadSlackCreds(instance: FastifyInstance): Promise<SlackCreds | null> {
  return loadSlackCredsFromDb(instance.db, instance.encryptionKey);
}

/** Default factory: client Slack reale via fetch globale. */
export const defaultSlackClientFactory: SlackClientFactory = (token) => createSlackClient(token);
