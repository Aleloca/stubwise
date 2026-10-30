import type { ChangeEntry } from "../changelog/types";
import { daysFromToday } from "./dates";

// Il registro delle modifiche del seme (area 9a, design «Dati finti»: una
// ventina di voci degli ultimi 30 giorni che coprono tutti i tipi di 9a). Sono
// FATTI coerenti col resto del seme: i due ruoli fatti a mano, la concessione
// di Marco su ACQ (Roberta, 20 giorni fa: `SEED_GRANTED_AT`), i due inviti,
// Simone disattivato 10 giorni fa. Nessuna voce contiene un segreto: il reset
// dice che il link è nato, mai il link.

const at = (days: number, time: string) => `${daysFromToday(days)}T${time}:00Z`;

const person = (id: string, label: string) => ({ type: "person", id, label });
const role = (id: string, label: string) => ({ type: "role", id, label });
const department = (id: string, label: string) => ({ type: "department", id, label });
const invite = (id: string, label: string) => ({ type: "invite", id, label });

type Row = Omit<ChangeEntry, "id" | "before" | "after" | "params"> &
  Partial<Pick<ChangeEntry, "before" | "after" | "params">>;

const ACQ = "prj-acq";
const STW = "prj-stw";
const AUD = "prj-aud";

const ROWS: Row[] = [
  {
    kind: "instance.first_admin_created",
    at: at(-30, "08:02"),
    actorId: "p-roberta",
    projectId: null,
    object: person("p-roberta", "Roberta Fontana"),
  },
  {
    kind: "role.created",
    at: at(-29, "09:10"),
    actorId: "p-roberta",
    projectId: null,
    object: role("role-rm-1", "Release manager"),
    after: "Release manager",
    params: { from: "Developer" },
  },
  {
    kind: "role.created",
    at: at(-29, "09:14"),
    actorId: "p-roberta",
    projectId: null,
    object: role("role-au-1", "Auditor"),
    after: "Auditor",
  },
  {
    kind: "role.created",
    at: at(-28, "16:20"),
    actorId: "p-roberta",
    projectId: null,
    object: role("role-reviewer", "Reviewer"),
    after: "Reviewer",
  },
  {
    kind: "role.updated",
    at: at(-27, "11:02"),
    actorId: "p-roberta",
    projectId: null,
    object: role("role-rm-1", "Release manager"),
    before: "Release manager",
    after: "Release manager",
    params: { added: "release.merge", removed: "" },
  },
  {
    kind: "department.created",
    at: at(-26, "10:30"),
    actorId: "p-roberta",
    projectId: null,
    object: department("dep-partnerships", "Partnerships"),
    after: "Partnerships",
  },
  {
    kind: "person.deactivated",
    at: at(-25, "17:45"),
    actorId: "p-roberta",
    projectId: null,
    object: person("p-enrico", "Enrico Palumbo"),
    params: { reassigned: "0" },
  },
  {
    kind: "department.members_changed",
    at: at(-24, "15:20"),
    actorId: "p-roberta",
    projectId: null,
    object: department("dep-support", "Support"),
    params: { added: "p-alessia", removed: "" },
  },
  {
    kind: "department.updated",
    at: at(-23, "09:05"),
    actorId: "p-roberta",
    projectId: null,
    object: department("dep-support", "Support"),
    before: "Customer care --dept-3",
    after: "Support --dept-3",
  },
  {
    kind: "department.permissions_changed",
    at: at(-22, "09:45"),
    actorId: "p-roberta",
    projectId: null,
    object: department("dep-development", "Development"),
    params: { added: "support.reply", removed: "", before: "", after: "support.reply" },
  },
  {
    kind: "department.home_managers_changed",
    at: at(-21, "16:00"),
    actorId: "p-roberta",
    projectId: null,
    object: department("dep-marketing", "Marketing"),
    params: { added: "p-giulia", removed: "" },
  },
  {
    kind: "member.permission_granted",
    at: at(-20, "10:00"),
    actorId: "p-roberta",
    projectId: ACQ,
    object: person("p-marco", "Marco Bellini"),
    after: "servers.operate",
    params: { permission: "servers.operate", project: "ACQ", role: "Developer" },
  },
  {
    kind: "member.permission_granted",
    at: at(-19, "11:40"),
    actorId: "p-laura",
    projectId: STW,
    object: person("p-federico", "Federico Sartori"),
    after: "release.merge",
    params: { permission: "release.merge", project: "STW", role: "Developer" },
  },
  {
    kind: "role.deleted",
    at: at(-19, "15:10"),
    actorId: "p-roberta",
    projectId: null,
    object: role("role-reviewer", "Reviewer"),
    before: "Reviewer",
  },
  {
    kind: "member.added",
    at: at(-18, "14:12"),
    actorId: "p-laura",
    projectId: AUD,
    object: person("p-stefano", "Stefano Amato"),
    after: "Developer",
    params: { role: "Developer", project: "AUD" },
  },
  {
    kind: "member.role_changed",
    at: at(-17, "11:30"),
    actorId: "p-laura",
    projectId: STW,
    object: person("p-sara", "Sara Montanari"),
    before: "Developer",
    after: "Contributor",
    params: { project: "STW" },
  },
  {
    kind: "person.instance_role_changed",
    at: at(-16, "09:00"),
    actorId: "p-roberta",
    projectId: null,
    object: person("p-silvia", "Silvia Longo"),
    before: "Admin",
    after: "User",
  },
  {
    kind: "person.git_identity_linked",
    at: at(-15, "17:40"),
    actorId: "p-roberta",
    projectId: null,
    object: person("p-federico", "Federico Sartori"),
    after: "federico.sartori@users.noreply.github.com",
  },
  {
    kind: "person.bitbucket_username_set",
    at: at(-14, "10:05"),
    actorId: "p-roberta",
    projectId: null,
    object: person("p-stefano", "Stefano Amato"),
    before: null,
    after: "samato",
  },
  {
    kind: "member.removed",
    at: at(-13, "12:00"),
    actorId: "p-laura",
    projectId: AUD,
    object: person("p-federico", "Federico Sartori"),
    before: "Developer",
    params: { project: "AUD" },
  },
  {
    kind: "invite.created",
    at: at(-12, "10:00"),
    actorId: "p-roberta",
    projectId: null,
    object: invite("inv-2", "kevin.ortega@example.com"),
    after: "User",
    params: { projects: "1" },
  },
  {
    kind: "person.password_reset_link_created",
    at: at(-11, "09:20"),
    actorId: "p-roberta",
    projectId: null,
    object: person("p-davide", "Davide Pellegrini"),
  },
  {
    kind: "person.deactivated",
    at: at(-10, "12:00"),
    actorId: "p-roberta",
    projectId: null,
    object: person("p-simone", "Simone Rossetti"),
    params: { reassigned: "0" },
  },
  {
    kind: "invite.created",
    at: at(-9, "15:00"),
    actorId: "p-roberta",
    projectId: null,
    object: invite("inv-old-1", "luca.ferraro@example.com"),
    after: "User",
    params: { projects: "1" },
  },
  {
    kind: "invite.revoked",
    at: at(-8, "09:30"),
    actorId: "p-roberta",
    projectId: null,
    object: invite("inv-old-1", "luca.ferraro@example.com"),
  },
  {
    kind: "invite.accepted",
    at: at(-7, "11:00"),
    actorId: "p-irene",
    projectId: null,
    object: invite("inv-old-2", "irene.caruso@example.com"),
    params: { projects: "1" },
  },
  {
    kind: "department.deleted",
    at: at(-6, "14:25"),
    actorId: "p-roberta",
    projectId: null,
    object: department("dep-partnerships", "Partnerships"),
    before: "Partnerships",
    params: { moved: "0", to: "" },
  },
  {
    kind: "person.second_factor_reset",
    at: at(-5, "10:15"),
    actorId: "p-roberta",
    projectId: null,
    object: person("p-giorgio", "Giorgio Barbieri"),
    params: { peer: "false" },
  },
  {
    kind: "person.git_identity_unlinked",
    at: at(-4, "16:50"),
    actorId: "p-roberta",
    projectId: null,
    object: person("p-federico", "Federico Sartori"),
    before: "f.sartori@old-laptop.local",
  },
  {
    kind: "member.permission_revoked",
    at: at(-3, "09:55"),
    actorId: "p-laura",
    projectId: STW,
    object: person("p-federico", "Federico Sartori"),
    before: "release.merge",
    params: { permission: "release.merge", project: "STW", role: "Developer" },
  },
  {
    kind: "person.reactivated",
    at: at(-2, "08:40"),
    actorId: "p-roberta",
    projectId: null,
    object: person("p-enrico", "Enrico Palumbo"),
  },
  {
    kind: "invite.created",
    at: at(-1, "10:00"),
    actorId: "p-roberta",
    projectId: null,
    object: invite("inv-1", "ines.ricci@example.com"),
    after: "User",
    params: { projects: "1" },
  },
  {
    kind: "member.added",
    at: at(0, "09:12"),
    actorId: "p-laura",
    projectId: ACQ,
    object: person("p-sara", "Sara Montanari"),
    after: "Contributor",
    params: { role: "Contributor", project: "ACQ" },
  },
  {
    kind: "role.updated",
    at: at(0, "10:40"),
    actorId: "p-roberta",
    projectId: null,
    object: role("role-au-1", "Auditor"),
    before: "Auditor",
    after: "Auditor",
    params: {
      added: "changelog.view",
      removed: "",
      before: "usage.view",
      after: "usage.view,changelog.view",
    },
  },
];

/** Le voci del seme, in ordine di scrittura (le più vecchie prima), congelate come quelle vere. */
export function seedChangelog(): ChangeEntry[] {
  return ROWS.map((row, i) =>
    Object.freeze({
      ...row,
      id: `chg-seed-${i + 1}`,
      before: row.before ?? null,
      after: row.after ?? null,
      object: Object.freeze({ ...row.object }),
      params: Object.freeze({ ...(row.params ?? {}) }),
    }),
  );
}
