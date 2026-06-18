import type { FastifyInstance } from "fastify";
import { decrypt, instanceSettings } from "@stubwise/db";
import { createSlackClient, type SlackClient } from "./api.js";

/**
 * Fabbrica del client Slack iniettabile a livello d'app: in produzione
 * costruisce il client reale dal bot token (con fetch globale); nei test si
 * passa un fake che non tocca la rete. Referenziata da BuildAppOptions e dalle
 * route Slack (sia quelle signature-authed sotto /api/slack, sia quelle
 * admin-authed di gestione identità).
 */
export type SlackClientFactory = (botToken: string) => SlackClient;

/** Credenziali Slack decifrate, o null se l'integrazione non è configurata. */
export interface SlackCreds {
  signingSecret: string;
  botToken: string;
}

/**
 * Carica e decifra signing secret + bot token dalle instance settings
 * (singleton id=1). Ritorna null se uno dei due manca (integrazione non
 * completa) o se la decifratura fallisce (blob corrotto/chiave errata): in
 * entrambi i casi il flusso Slack è trattato come "non abilitato". I segreti
 * non vengono mai loggati.
 */
export async function loadSlackCreds(instance: FastifyInstance): Promise<SlackCreds | null> {
  const [row] = await instance.db
    .select({
      signing: instanceSettings.slackSigningSecretEncrypted,
      bot: instanceSettings.slackBotTokenEncrypted,
    })
    .from(instanceSettings)
    .limit(1);
  if (!row?.signing || !row.bot) return null;
  try {
    return {
      signingSecret: decrypt(row.signing, instance.encryptionKey),
      botToken: decrypt(row.bot, instance.encryptionKey),
    };
  } catch {
    return null;
  }
}

/** Default factory: client Slack reale via fetch globale. */
export const defaultSlackClientFactory: SlackClientFactory = (token) => createSlackClient(token);
