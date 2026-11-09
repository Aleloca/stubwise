import {
  accessState,
  isFullAdmin,
  writeAccess,
  type AccessState,
  type PersonAccess,
} from "../access/index";
import { reassignTask } from "../api-mutations";
import { recordChange } from "../changelog/index";
import { COMMITS } from "../seed/commits";
import { logSecurity, publishSecurityAlert } from "../me/securityLog";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { copy, familyOf, gate, now, state, visibleProjectIds } from "../store";
import type { Task } from "../types";
import { writer } from "../writer";
import { forgetResetLinksOf } from "../auth/resetPassword";
import {
  avatarOf,
  canI,
  emailOf,
  escalationIn,
  invariantRefusal,
  isActive,
  isHumanId,
  missingIn,
  nameOf,
  reauthRefusal,
  refuse,
  roleById,
} from "./common";
import { forgetSecret, secretIdsOf, storeSecret } from "./secrets";
import { canJoin, extraPermissionsOf } from "./members";
import type {
  ActionBlock,
  AdminRefusal,
  AdminResult,
  ObservedAuthor,
  PeopleFilter,
  PersonDetail,
  PersonRow,
  SecurityEvent,
} from "./types";
import "./changeTypes";

// People (area 9a): l'elenco delle persone (lo legge chiunque), la pagina di
// una persona e le azioni di `users.manage`. Claude non è una persona
// dell'Amministrazione: non compare e risponde `not_found`. I progetti di una
// persona sono solo quelli che chi guarda vede (R-G5).
//
// Le azioni su sé stessi (ruolo d'istanza, reset, disattivazione) sono
// rifiutate, come sul web: le proprie cose stanno nelle Preferenze. Niente
// gerarchia (maintainer, 30 ott): chi ha `users.manage` agisce su chiunque,
// anche su chi ha più permessi; restano l'anti-escalation sul ruolo che si
// DÀ e «resta sempre un full admin».

const USERS_MANAGE = "users.manage";

/** Un link di reset dura un'ora (come sul web). */
const RESET_LINK_HOURS = 1;

const accessOf = (personId: string): PersonAccess | undefined =>
  accessState().people.find((p) => p.personId === personId);

const instanceRoleView = (personId: string) => {
  const role = roleById(accessOf(personId)?.instanceRoleId ?? "");
  return role ? { id: role.id, name: role.name } : null;
};

const departmentsOf = (personId: string) =>
  accessState()
    .departments.filter((d) => d.memberIds.includes(personId))
    .map((d) => state.departments.find((x) => x.id === d.departmentId))
    .filter((d) => d !== undefined)
    .map((d) => ({ id: d.id, name: d.name, colorToken: d.colorToken }));

/** I progetti della persona che chi guarda vede, con il ruolo. */
function visibleProjectsOf(me: string, personId: string) {
  const visible = visibleProjectIds(me);
  return accessState()
    .memberships.filter((m) => m.personId === personId && visible.has(m.projectId))
    .map((m) => ({ membership: m, project: state.projectsById.get(m.projectId)! }))
    .filter((x) => x.project !== undefined)
    .sort((a, b) => a.project.code.localeCompare(b.project.code));
}

const isOpen = (task: Task): boolean => familyOf(task) !== "closed";

/**
 * Pari grado: un full admin che agisce su un altro full admin. Il reset del
 * secondo fattore fra pari grado è accettato, registrato e detto
 * all'interessato (`second-factor.md`): la pagina lo legge da `peer`.
 */
const isPeer = (me: string, personId: string): boolean =>
  isFullAdmin(me) && isFullAdmin(personId);

// --- letture ----------------------------------------------------------------

/**
 * L'elenco di People, per chiunque. Gli inviti in sospeso sono righe
 * «invited» solo per chi ha `users.invite`. Ordine: per nome, gli inviti dopo
 * le persone attive, i disattivati in fondo.
 */
export async function listPeople(filter: PeopleFilter = {}): Promise<PersonRow[]> {
  const me = await gate("admin.listPeople");
  const rows: PersonRow[] = [];
  for (const p of accessState().people) {
    if (!isHumanId(p.personId)) continue;
    rows.push({
      personId: p.personId,
      name: nameOf(p.personId) ?? p.personId,
      email: emailOf(p.personId),
      avatar: avatarOf(p.personId),
      instanceRole: instanceRoleView(p.personId),
      departments: departmentsOf(p.personId),
      projects: visibleProjectsOf(me, p.personId).map(({ membership, project }) => ({
        code: project.code,
        role: roleById(membership.roleId)?.name ?? "",
      })),
      status: p.status,
      deactivatedAt: p.deactivatedAt,
      invite: null,
    });
  }
  if (canI(me, "users.invite")) {
    const visible = visibleProjectIds(me);
    for (const inv of pendingInvites()) {
      rows.push({
        personId: inv.id,
        name: inv.email,
        email: inv.email,
        avatar: "",
        instanceRole: roleById(inv.instanceRoleId)
          ? { id: inv.instanceRoleId, name: roleById(inv.instanceRoleId)!.name }
          : null,
        departments: [],
        projects: inv.projects
          .filter((x) => visible.has(x.projectId))
          .map((x) => ({
            code: state.projectsById.get(x.projectId)?.code ?? "",
            role: roleById(x.roleId)?.name ?? "",
          })),
        status: "invited",
        deactivatedAt: null,
        invite: {
          id: inv.id,
          expiresAt: inv.expiresAt,
          expired: Date.parse(inv.expiresAt) < Date.parse(now()),
          invitedByName: nameOf(inv.invitedById) ?? "",
        },
      });
    }
  }
  const rank = { active: 0, invited: 1, deactivated: 2 } as const;
  const q = filter.q?.trim().toLowerCase();
  return rows
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q))
    .filter(
      (r) =>
        !filter.departmentIds?.length ||
        r.departments.some((d) => filter.departmentIds!.includes(d.id)),
    )
    .filter(
      (r) =>
        !filter.instanceRoleIds?.length ||
        (r.instanceRole !== null && filter.instanceRoleIds.includes(r.instanceRole.id)),
    )
    .filter((r) => !filter.statuses?.length || filter.statuses.includes(r.status))
    .sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}

/** Gli inviti non revocati né accettati (anche scaduti: si vedono come «Expired»). */
export const pendingInvites = () =>
  state.invites.filter((i) => i.revokedAt === null && i.acceptedAt === null);

/** Il motivo per cui un'azione su una persona non si fa (o `null`), senza le regole di stato. */
function blockFor(me: string, personId: string, opts: { notSelf: boolean }): ActionBlock {
  if (!canI(me, USERS_MANAGE)) return "forbidden";
  if (opts.notSelf && personId === me) return "self";
  return null;
}

/** Il blocco «resta sempre un full admin» di una disattivazione, senza scrivere. */
const deactivateMutation = (personId: string) => (s: AccessState) => {
  const p = s.people.find((x) => x.personId === personId)!;
  p.status = "deactivated";
  p.deactivatedAt = now();
};

/** La pagina di una persona. Claude, un id sconosciuto o un invito: `not_found`. */
export async function getPerson(personId: string): Promise<PersonDetail> {
  const me = await gate("admin.getPerson");
  const access = accessOf(personId);
  if (!access || !isHumanId(personId)) throw new Error("not_found");
  const manage = canI(me, USERS_MANAGE);
  const visible = visibleProjectIds(me);
  const memberships = accessState().memberships.filter((m) => m.personId === personId);
  const deactivate =
    blockFor(me, personId, { notSelf: true }) ??
    (access.status !== "active"
      ? "status"
      : ((invariantRefusal(deactivateMutation(personId)) as { reason?: string } | null)?.reason ??
        null));
  const setInstanceRole = blockFor(me, personId, { notSelf: true });
  return {
    personId,
    name: nameOf(personId) ?? personId,
    email: emailOf(personId),
    avatar: avatarOf(personId),
    status: access.status,
    deactivatedAt: access.deactivatedAt,
    isSelf: personId === me,
    isFullAdmin: isFullAdmin(personId),
    hasSecondFactor: access.secondFactor !== null,
    peer: isPeer(me, personId),
    instanceRole: instanceRoleView(personId),
    projects: visibleProjectsOf(me, personId).map(({ membership, project }) => ({
      projectId: project.id,
      code: project.code,
      name: project.name,
      role: { id: membership.roleId, name: roleById(membership.roleId)?.name ?? "" },
      extra: extraPermissionsOf(personId, project.id),
      canManage: canI(me, "project.members.manage", project.id),
    })),
    alsoInHiddenProjects: memberships.some((m) => !visible.has(m.projectId)),
    // «Add to a project»: la stessa regola di chi si può aggiungere in Members.
    addableTo: state.projects
      .filter(
        (p) =>
          visible.has(p.id) &&
          canI(me, "project.members.manage", p.id) &&
          canJoin(personId, p.id),
      )
      .map((p) => ({ projectId: p.id, code: p.code, name: p.name }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    departments: accessState()
      .departments.filter((d) => d.memberIds.includes(personId))
      .map((d) => {
        const dept = state.departments.find((x) => x.id === d.departmentId);
        return {
          id: d.departmentId,
          name: dept?.name ?? d.departmentId,
          colorToken: dept?.colorToken ?? "",
          managesHome: d.homeManagerIds.includes(personId),
        };
      }),
    identities: {
      gitEmails: [...state.commitAuthorLinks]
        .filter(([, id]) => id === personId)
        .map(([identity]) => identity)
        .sort(),
      bitbucketUsername: state.bitbucketUsernames.get(personId) ?? null,
    },
    actions: {
      setInstanceRole,
      resetPassword:
        blockFor(me, personId, { notSelf: true }) ?? (access.status !== "active" ? "status" : null),
      resetSecondFactor:
        blockFor(me, personId, { notSelf: true }) ??
        (access.secondFactor === null ? "no_second_factor" : null),
      deactivate,
      reactivate:
        blockFor(me, personId, { notSelf: true }) ??
        (access.status === "deactivated" ? null : "status"),
      identities: blockFor(me, personId, { notSelf: false }),
    },
    instanceRoleChoices: manage
      ? accessState()
          .roles.filter((r) => r.scope === "instance")
          .map((r) => ({
            roleId: r.id,
            name: r.name,
            permissionCount: r.permissions.length,
            missing: missingIn(me, "instance", r.permissions),
          }))
      : [],
    openTasks: state.tasks
      .filter((t) => t.assigneeId === personId && isOpen(t) && visible.has(t.projectId))
      .map((t) => ({
        taskId: t.id,
        code: t.code,
        title: t.title,
        projectId: t.projectId,
        reassignTo: (state.projectsById.get(t.projectId)?.memberIds ?? []).filter(
          (id) => id !== personId && (id === CLAUDE_ID || isActive(id)),
        ),
      })),
  };
}

/** Il registro della sicurezza di una persona (`users.manage`), più recenti prima. */
export async function listSecurityEvents(
  personId: string,
): Promise<(SecurityEvent & { byName: string | null })[]> {
  const me = await gate("admin.listSecurityEvents");
  if (!isHumanId(personId)) throw new Error("not_found");
  if (!canI(me, USERS_MANAGE)) throw new Error("forbidden");
  return state.securityEvents
    .filter((e) => e.personId === personId)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map((e) => ({ ...copy(e), byName: nameOf(e.byId) }));
}

/**
 * Gli autori git dei commit non ancora collegati a una persona, nei progetti
 * che chi guarda vede: la stessa ricerca dell'Activity (area 3).
 */
export async function listObservedAuthors(): Promise<ObservedAuthor[]> {
  const me = await gate("admin.listObservedAuthors");
  if (!canI(me, USERS_MANAGE)) throw new Error("forbidden");
  const visible = visibleProjectIds(me);
  const byName = new Map<string, ObservedAuthor>();
  for (const c of COMMITS) {
    if (c.authorId !== null || state.commitAuthorLinks.has(c.authorName)) continue;
    if (!visible.has(c.projectId)) continue;
    const code = state.projectsById.get(c.projectId)?.code ?? "";
    const row = byName.get(c.authorName) ?? {
      name: c.authorName,
      commits: 0,
      projectCodes: [],
      lastAt: c.at,
    };
    row.commits += 1;
    if (!row.projectCodes.includes(code)) row.projectCodes.push(code);
    if (c.at > row.lastAt) row.lastAt = c.at;
    byName.set(c.authorName, row);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// --- scritture --------------------------------------------------------------

/** La persona su cui agire con `users.manage`: umana (o `not_found`), con il permesso (o `forbidden`). */
function target(me: string, personId: string): AdminRefusal | null {
  if (!isHumanId(personId)) return refuse.notFound();
  if (!canI(me, USERS_MANAGE)) return refuse.forbidden();
  return null;
}

const label = (personId: string) => ({
  type: "person",
  id: personId,
  label: nameOf(personId) ?? personId,
});

/**
 * Cambia il ruolo d'istanza (`users.manage`, +R, mai su sé stessi). Si dà
 * solo un ruolo i cui permessi chi agisce ha; non si toglie il full admin
 * all'ultimo. Le revoche d'istanza della persona si azzerano.
 */
export async function setInstanceRole(personId: string, roleId: string): Promise<AdminResult> {
  const me = await writer("admin.setInstanceRole");
  const blocked = target(me, personId);
  if (blocked) return blocked;
  if (personId === me) return refuse.invalid("self");
  const role = roleById(roleId);
  if (!role || role.scope !== "instance") return refuse.invalid("role");
  const before = roleById(accessOf(personId)!.instanceRoleId);
  if (before?.id === role.id) return refuse.invalid("unchanged");
  const escalation = escalationIn(me, "instance", role.permissions);
  if (escalation) return escalation;
  const mutate = (s: AccessState) => {
    s.people.find((p) => p.personId === personId)!.instanceRoleId = role.id;
    s.revocations = s.revocations.filter((r) => !(r.personId === personId && r.projectId === null));
  };
  const invariant = invariantRefusal(mutate);
  if (invariant) return invariant;
  const reauth = reauthRefusal(me, "admin.setInstanceRole");
  if (reauth) return reauth;
  writeAccess(mutate);
  recordChange({
    kind: "person.instance_role_changed",
    actorId: me,
    projectId: null,
    object: label(personId),
    before: before?.name ?? null,
    after: role.name,
  });
  return { ok: true };
}

/**
 * Un link monouso per reimpostare la password (+R, mai su sé stessi): si
 * vede qui e mai più. Un link precedente della persona smette di valere.
 */
export async function createPasswordResetLink(
  personId: string,
): Promise<AdminResult<{ link: string; expiresAt: string }>> {
  const me = await writer("admin.createPasswordResetLink");
  const blocked = target(me, personId);
  if (blocked) return blocked;
  if (personId === me) return refuse.invalid("self");
  if (!isActive(personId)) return refuse.invalid("status");
  const reauth = reauthRefusal(me, "admin.createPasswordResetLink");
  if (reauth) return reauth;
  // Un link precedente smette di valere: chi lo apre legge «link sconosciuto».
  forgetResetLinksOf(personId);
  const { id: secretId, value } = storeSecret("reset_link", personId);
  const expiresAt = new Date(Date.parse(now()) + RESET_LINK_HOURS * 3_600_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  state.resetLinks.push({ secretId, personId, expiresAt, usedAt: null });
  logSecurity(personId, "password_reset_link_created", me);
  // `second-factor.md`: un link di reset generato da un altro avvisa
  // l'interessato, solo lui. Il link, mai: dice chi e cosa.
  publishSecurityAlert(
    personId,
    "Password reset link created",
    `${nameOf(me)} created a link to reset your password. It works once, within an hour. If you didn't ask for it, tell your administrator.`,
  );
  // La voce dice che il link è stato creato: il link, mai.
  recordChange({
    kind: "person.password_reset_link_created",
    actorId: me,
    projectId: null,
    object: label(personId),
  });
  return { ok: true, link: value, expiresAt };
}

/**
 * Azzera il secondo fattore (+R, mai su sé stessi): la persona lo rifà al
 * prossimo accesso e riceve `security.alert`, solo lei. Fra pari grado
 * (un full admin su un altro) è accettato, registrato e avvisato.
 */
export async function resetSecondFactor(personId: string): Promise<AdminResult> {
  const me = await writer("admin.resetSecondFactor");
  const blocked = target(me, personId);
  if (blocked) return blocked;
  if (personId === me) return refuse.invalid("self");
  if (accessOf(personId)!.secondFactor === null) return refuse.invalid("no_second_factor");
  const reauth = reauthRefusal(me, "admin.resetSecondFactor");
  if (reauth) return reauth;
  writeAccess((s) => {
    s.people.find((p) => p.personId === personId)!.secondFactor = null;
  });
  for (const kind of ["totp_seed", "backup_codes"] as const)
    for (const id of secretIdsOf(kind, personId)) forgetSecret(id);
  state.confirmedTotp.delete(personId);
  state.passkeys = state.passkeys.filter((k) => k.personId !== personId);
  // Esce ovunque (come il server, `second-factor/reset.ts`): rientra dal login e rifà il secondo fattore.
  state.sessions = state.sessions.filter((s) => s.personId !== personId);
  logSecurity(personId, "second_factor_reset", me);
  publishSecurityAlert(
    personId,
    "Two-step verification reset",
    `${nameOf(me)} reset your two-step verification. Set it up again at your next sign-in.`,
  );
  recordChange({
    kind: "person.second_factor_reset",
    actorId: me,
    projectId: null,
    object: label(personId),
    params: { peer: String(isPeer(me, personId)) },
  });
  return { ok: true };
}

/**
 * Il collegamento di un'identità git, senza cancello né permessi (li fa chi
 * chiama): da lì i suoi commit passano sotto la persona, e il registro lo
 * dice. È l'UNICA scrittura del collegamento: la usano questa pagina
 * (`linkGitIdentity`) e «Link a person» dell'Activity (`linkCommitAuthor`).
 */
export function linkIdentityAs(me: string, personId: string, identity: string): void {
  state.commitAuthorLinks.set(identity, personId);
  recordChange({
    kind: "person.git_identity_linked",
    actorId: me,
    projectId: null,
    object: label(personId),
    after: identity,
  });
}

/**
 * Collega un'identità git (un autore osservato o un'email nuova) a una
 * persona (`users.manage`): da lì i suoi commit passano sotto di lei, come
 * «Link a person» dell'Activity.
 */
export async function linkGitIdentity(personId: string, identity: string): Promise<AdminResult> {
  const me = await writer("admin.linkGitIdentity");
  const blocked = target(me, personId);
  if (blocked) return blocked;
  const value = identity.trim();
  if (!value) return refuse.invalid("identity");
  if (
    state.commitAuthorLinks.has(value) ||
    COMMITS.some((c) => c.authorId && c.authorName === value)
  )
    return refuse.invalid("identity_taken");
  linkIdentityAs(me, personId, value);
  return { ok: true };
}

/** Scollega un'identità git (`users.manage`, +R): i suoi commit tornano «non collegati». */
export async function unlinkGitIdentity(personId: string, identity: string): Promise<AdminResult> {
  const me = await writer("admin.unlinkGitIdentity");
  const blocked = target(me, personId);
  if (blocked) return blocked;
  if (state.commitAuthorLinks.get(identity) !== personId) return refuse.invalid("not_linked");
  const reauth = reauthRefusal(me, "admin.unlinkGitIdentity");
  if (reauth) return reauth;
  state.commitAuthorLinks.delete(identity);
  recordChange({
    kind: "person.git_identity_unlinked",
    actorId: me,
    projectId: null,
    object: label(personId),
    before: identity,
  });
  return { ok: true };
}

/** Collega (o, con `null`, scollega) lo username Bitbucket (`users.manage`). */
export async function setBitbucketUsername(
  personId: string,
  username: string | null,
): Promise<AdminResult> {
  const me = await writer("admin.setBitbucketUsername");
  const blocked = target(me, personId);
  if (blocked) return blocked;
  const value = username?.trim() || null;
  const taken = [...state.bitbucketUsernames].some(([id, u]) => id !== personId && u === value);
  if (value !== null && taken) return refuse.invalid("identity_taken");
  const before = state.bitbucketUsernames.get(personId) ?? null;
  if (before === value) return refuse.invalid("unchanged");
  if (value === null) state.bitbucketUsernames.delete(personId);
  else state.bitbucketUsernames.set(personId, value);
  recordChange({
    kind: "person.bitbucket_username_set",
    actorId: me,
    projectId: null,
    object: label(personId),
    before,
    after: value,
  });
  return { ok: true };
}

/**
 * Disattiva una persona (+R, mai sé stessi, mai l'ultimo full admin): non
 * entra più e sparisce da chi si assegna; il suo lavoro resta. `reassignTo`
 * dice, per ogni task aperta che si vuole riassegnare, a chi (una persona
 * attiva del progetto della task, o Claude se ne è membro); le task non
 * nominate, o con `null`, restano sue con «(deactivated)». Gli inviti che
 * aveva mandato e ancora in attesa si revocano, una voce `invite.revoked`
 * ciascuno.
 */
export async function deactivatePerson(
  personId: string,
  reassignTo: Record<string, string | null> = {},
): Promise<AdminResult<{ reassigned: number }>> {
  const me = await writer("admin.deactivatePerson");
  const blocked = target(me, personId);
  if (blocked) return blocked;
  if (personId === me) return refuse.invalid("self");
  if (!isActive(personId)) return refuse.invalid("status");
  const visible = visibleProjectIds(me);
  const moves: [Task, string][] = [];
  for (const [taskId, to] of Object.entries(reassignTo)) {
    const task = state.tasksById.get(taskId);
    if (!task || !visible.has(task.projectId)) return refuse.notFound();
    if (task.assigneeId !== personId || !isOpen(task)) return refuse.invalid("task");
    if (to === null) continue;
    const members = state.projectsById.get(task.projectId)?.memberIds ?? [];
    if (to === personId || !members.includes(to) || (to !== CLAUDE_ID && !isActive(to)))
      return refuse.invalid("assignee");
    moves.push([task, to]);
  }
  const mutate = deactivateMutation(personId);
  const invariant = invariantRefusal(mutate);
  if (invariant) return invariant;
  const reauth = reauthRefusal(me, "admin.deactivatePerson");
  if (reauth) return reauth;
  writeAccess(mutate);
  for (const [task, to] of moves) reassignTask(me, task, to);
  // Esce (area 9a): le sue sessioni si chiudono; i token restano, ma non
  // valgono finché è disattivata (`callWithToken`).
  state.sessions = state.sessions.filter((s) => s.personId !== personId);
  // Un link di reset aperto non torna buono riattivando la persona.
  forgetResetLinksOf(personId);
  // I suoi inviti ancora in attesa si revocano (maintainer, 30 ott 2026),
  // come a mano: il link dice «revocato» e non torna buono riattivandola.
  // Gli scaduti restano come sono: non sono più in attesa.
  const at = now();
  for (const invite of pendingInvites()) {
    if (invite.invitedById !== personId || Date.parse(invite.expiresAt) <= Date.parse(at))
      continue;
    invite.revokedAt = at;
    recordChange({
      kind: "invite.revoked",
      actorId: me,
      projectId: null,
      object: { type: "invite", id: invite.id, label: invite.email },
    });
  }
  logSecurity(personId, "deactivated", me);
  recordChange({
    kind: "person.deactivated",
    actorId: me,
    projectId: null,
    object: label(personId),
    params: { reassigned: String(moves.length) },
  });
  return { ok: true, reassigned: moves.length };
}

/** Riattiva una persona (`users.manage`): progetti, ruoli e reparti tornano come erano. */
export async function reactivatePerson(personId: string): Promise<AdminResult> {
  const me = await writer("admin.reactivatePerson");
  const blocked = target(me, personId);
  if (blocked) return blocked;
  if (accessOf(personId)!.status !== "deactivated") return refuse.invalid("status");
  // Restituisce l'account intero: riconferma, come la disattivazione. Niente
  // escalation: nessuna gerarchia (maintainer, 30 ott), come per I3.
  const reauth = reauthRefusal(me, "admin.reactivatePerson");
  if (reauth) return reauth;
  writeAccess((s) => {
    const p = s.people.find((x) => x.personId === personId)!;
    p.status = "active";
    p.deactivatedAt = null;
  });
  logSecurity(personId, "reactivated", me);
  recordChange({
    kind: "person.reactivated",
    actorId: me,
    projectId: null,
    object: label(personId),
  });
  return { ok: true };
}

/** Lo stato di un assegnatario, per «(deactivated)» nella vista della task. */
export function assigneeStatusOf(personId: string | null): "active" | "deactivated" | null {
  if (personId === null) return null;
  return accessOf(personId)?.status ?? (PEOPLE.some((p) => p.id === personId) ? "active" : null);
}
