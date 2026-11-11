/**
 * Il canale NOTIFY dello stream della Chat: `{"channelId": …}` a ogni cambio
 * di un canale o di un suo messaggio. Un modulo foglia, così lo importano
 * `service.ts`, `claude.ts` e le proposte senza un giro fra moduli. Il nome
 * lo usano anche i trigger della 0141: non si cambia.
 */
export const CHAT_CHANNEL_NOTIFY = "chat_channel";
