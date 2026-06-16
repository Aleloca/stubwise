import { z } from "zod";

/**
 * Lingua supportata da Stubwise. Unica fonte di verità per i valori, condivisa
 * tra DB (pgEnum `language`), server (validazione) e web (UI/i18n): la lingua
 * dell'utente (`users.language`) e quella dei contenuti generati
 * (`instance_settings.content_language`) derivano entrambe da qui.
 */
export const languageSchema = z.enum(["en", "it"]);
export type Language = z.infer<typeof languageSchema>;
