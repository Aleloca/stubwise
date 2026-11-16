import { adminRoleViewSchema, inviteChoicesSchema, inviteViewSchema, personDetailSchema, personRowSchema } from "@stubwise/shared";
import type { AdminRoleView, InviteChoices, InviteView, PersonDetail, PersonRow, Reader } from "@stubwise/shared";
import { z } from "zod";
import type { ApiRequest } from "../client.js";
import { seg } from "../query.js";

/**
 * Area 9, F1 (R7 del renderer): le letture CALCOLATE dell'amministrazione.
 * I campi «si può / manca» (`actions`, `missing`, `deleteBlock`…) li calcola il
 * server con le regole delle scritture: il client li legge, non li deduce.
 */
export function createAdminEndpoints(request: ApiRequest) {
  return {
    /** Le persone che chi guarda vede, più gli inviti pendenti a chi può invitare. */
    people(): Promise<Reader<PersonRow>[]> {
      return request("GET", "/api/admin/people", undefined, z.array(personRowSchema));
    },
    /** La pagina di una persona (404 se chi guarda non la vede). */
    person(id: string): Promise<Reader<PersonDetail>> {
      return request("GET", `/api/admin/people/${seg(id)}`, undefined, personDetailSchema);
    },
    roles(): Promise<Reader<AdminRoleView>[]> {
      return request("GET", "/api/admin/roles", undefined, z.array(adminRoleViewSchema));
    },
    /** Gli inviti pendenti: l'`id` è opaco, il token non esce mai. */
    invites(): Promise<Reader<InviteView>[]> {
      return request("GET", "/api/admin/invites", undefined, z.array(inviteViewSchema));
    },
    revokeInvite(id: string): Promise<void> {
      return request("DELETE", `/api/admin/invites/${seg(id)}`);
    },
    inviteChoices(): Promise<Reader<InviteChoices>> {
      return request("GET", "/api/admin/invite-choices", undefined, inviteChoicesSchema);
    },
  };
}
