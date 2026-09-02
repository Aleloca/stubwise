import { z } from "zod";
import { languageSchema } from "./language.js";

/**
 * Proiezione PUBBLICA di un utente: l'identità e nient'altro. È ciò che
 * restituiscono setup, login e registrazione — che creano l'utente prima di
 * conoscerne la sessione, e quindi non hanno né la lingua né l'identità Slack
 * da dare indietro.
 *
 * Chi vuole l'avatar dopo il login fa la seconda chiamata a `/me`: non è un
 * dettaglio di implementazione, è il contratto.
 */
export const publicUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: z.enum(["admin", "member"]),
});
export type PublicUser = z.infer<typeof publicUserSchema>;

/**
 * L'utente della SESSIONE corrente, esposto da `/me`: la proiezione pubblica
 * più la preferenza di lingua (con cui la UI allinea i18n dopo il login) e
 * l'identità Slack — avatar e Slack user id, entrambi null finché un admin non
 * linka l'utente (o finché non scatta l'auto-link per attribuzione).
 */
export const sessionUserSchema = publicUserSchema.extend({
  language: languageSchema,
  avatarUrl: z.string().nullable(),
  slackUserId: z.string().nullable(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;
