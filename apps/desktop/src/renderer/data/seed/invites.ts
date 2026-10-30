import type { Invite, SecurityEvent } from "../admin/types";
import { daysFromToday } from "./dates";

// Gli inviti e il registro della sicurezza del seme (area 9a). Due inviti,
// fatti da Roberta: uno in sospeso, uno scaduto. Il loro link nessuno lo ha
// più (si vede una volta, quando si crea): `secretId` è `null`.

const at = (days: number, time = "10:00") => `${daysFromToday(days)}T${time}:00Z`;

export const INVITES: Invite[] = [
  {
    id: "inv-1",
    email: "ines.ricci@example.com",
    instanceRoleId: "role-user",
    projects: [{ projectId: "prj-stw", roleId: "role-developer" }],
    invitedById: "p-roberta",
    createdAt: at(-1),
    expiresAt: at(6),
    revokedAt: null,
    acceptedAt: null,
    secretId: null,
  },
  {
    id: "inv-2",
    email: "kevin.ortega@example.com",
    instanceRoleId: "role-user",
    projects: [{ projectId: "prj-acq", roleId: "role-developer" }],
    invitedById: "p-roberta",
    createdAt: at(-12),
    expiresAt: at(-5),
    revokedAt: null,
    acceptedAt: null,
    secretId: null,
  },
];

/**
 * Il registro della sicurezza: gli stessi fatti delle notifiche
 * `security.alert` del seme (SEC-1…SEC-4), più l'attivazione del secondo
 * fattore di Marco e Laura.
 */
export const SECURITY_EVENTS: SecurityEvent[] = [
  { id: "sev-1", personId: "p-giulia", kind: "signed_in", at: at(-4, "20:00"), byId: null },
  { id: "sev-2", personId: "p-giulia", kind: "password_changed", at: at(0, "18:00"), byId: null },
  { id: "sev-3", personId: "p-sara", kind: "signed_in", at: at(0, "12:00"), byId: null },
  {
    id: "sev-4",
    personId: "p-roberta",
    kind: "second_factor_enabled",
    at: at(-1, "18:00"),
    byId: null,
  },
  { id: "sev-5", personId: "p-marco", kind: "second_factor_enabled", at: at(-40), byId: null },
  { id: "sev-6", personId: "p-laura", kind: "second_factor_enabled", at: at(-60), byId: null },
];
