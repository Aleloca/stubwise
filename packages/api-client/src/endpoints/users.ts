import { emailChangedSchema, passwordResetLinkSchema, publicUserSchema } from "@stubwise/shared";
import type { EmailChanged, PasswordResetLink, PublicUser, Reader } from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

/**
 * Parsato con la proiezione PUBBLICA (`publicUserSchema`: id, email, ruolo) e
 * non con lo schema esteso che la rotta dichiara (`teamUserSchema`, definito
 * lato server: aggiunge username Bitbucket e identità git).
 *
 * Non è una svista. Chi legge questo elenco lo legge per un selettore di
 * assegnatario, dove serve un nome da mostrare e un id da mandare; zod
 * spoglia il resto, quindi un campo aggiunto domani alla pagina Team non
 * arriva fin qui e non può romperne il parse. Se un giorno servisse
 * davvero, lo schema esteso va spostato in `@stubwise/shared` — non
 * ricopiato qui.
 */
const usersSchema = z.array(publicUserSchema);

/**
 * Gli utenti dell'istanza. Aperta a ogni utente (intera con `users.view_all`,
 * altrimenti chi condivide un progetto e i full admin): la lista esiste
 * proprio perché ogni superficie possa disegnare il selettore degli
 * assegnatari, e non espone nulla oltre a identità e ruolo.
 */
export function createUsersEndpoints(request: ApiRequest) {
  return {
    list(): Promise<Reader<PublicUser>[]> {
      return request("GET", "/api/users", undefined, usersSchema);
    },

    /**
     * Area 9, F1: disattiva (riconferma, `users.manage`), 204. `reassign`
     * dice a chi va ogni task aperta (id task → id persona, o null per
     * lasciarla); una riga non valida è 422 `invalid_reassignment` col
     * `taskId`, e niente cambia. Mai sé stessi, l'ultimo full admin, Claude.
     */
    deactivate(userId: string, reassign?: Record<string, string | null>): Promise<void> {
      return request("POST", `/api/users/${seg(userId)}/deactivate`, reassign ? { reassign } : {});
    },
    reactivate(userId: string): Promise<void> {
      return request("POST", `/api/users/${seg(userId)}/reactivate`);
    },

    /**
     * Il cambio dell'email di un altro, subito (riconferma, `users.manage`).
     * Errori: 400 `cannot_change_own_email`, 404 `user_not_found`, 409 `email_taken`.
     */
    changeEmail(userId: string, email: string): Promise<Reader<EmailChanged>> {
      return request("PATCH", `/api/users/${seg(userId)}/email`, { email }, emailChangedSchema);
    },

    /** Il link di reset della password: `token` per comporre il link della web «app». */
    passwordReset(userId: string): Promise<Reader<PasswordResetLink>> {
      return request("POST", `/api/users/${seg(userId)}/password-reset`, undefined, passwordResetLinkSchema);
    },
  };
}
