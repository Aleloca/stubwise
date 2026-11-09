import type { ChatMessage } from "../../types";
import { AUD_MESSAGES } from "./aud";
import { COMPANY_MESSAGES } from "./company";
import { DM_MESSAGES } from "./dms";
import { MKX_MESSAGES } from "./mkx";
import { STW_MESSAGES } from "./stw";

/** Tutti i messaggi del seme, canale per canale. */
export const CHAT_MESSAGES: ChatMessage[] = [
  ...AUD_MESSAGES,
  ...STW_MESSAGES,
  ...MKX_MESSAGES,
  ...COMPANY_MESSAGES,
  ...DM_MESSAGES,
];
