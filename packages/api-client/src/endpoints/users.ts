import { publicUserSchema } from "@stubwise/shared";
import type { PublicUser, Reader } from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";

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
 * Gli utenti dell'istanza. `requireAuth`, non `requireAdmin`: la lista esiste
 * proprio perché ogni superficie possa disegnare il selettore degli
 * assegnatari, e non espone nulla oltre a identità e ruolo.
 */
export function createUsersEndpoints(request: ApiRequest) {
  return {
    list(): Promise<Reader<PublicUser>[]> {
      return request("GET", "/api/users", undefined, usersSchema);
    },
  };
}
