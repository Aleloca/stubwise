import { beforeEach, describe, expect, it } from "vitest";
import { resetApi } from "../api";
import { accessState, instanceRoleOf } from "../access/index";
import { state } from "../store";
import { seedChangelog } from "./changelog";

// Il registro del seme è FATTO: ogni voce d'identità, di ruolo, di membro, di
// reparto e di stato di una persona deve dire lo stato del seme. Conta l'ultima
// voce sullo stesso oggetto (un permesso dato e poi tolto, un ruolo creato e
// poi eliminato): quella dice com'è adesso.

beforeEach(() => resetApi());

const entries = seedChangelog();
const list = (v: string | undefined) => (v ? v.split(",").filter(Boolean) : []);
/** Vero se nessuna voce più recente parla della stessa cosa (`key`). */
const latest = (i: number, key: (e: (typeof entries)[number]) => string | null) =>
  !entries.slice(i + 1).some((e) => key(e) !== null && key(e) === key(entries[i]!));
const roleOf = (id: string) => accessState().roles.find((r) => r.id === id);
const deptAccess = (id: string) => accessState().departments.find((d) => d.departmentId === id);
const membership = (personId: string, projectId: string) =>
  accessState().memberships.find((m) => m.personId === personId && m.projectId === projectId);

describe("il registro del seme dice lo stato del seme", () => {
  it("ogni voce, l'ultima su ogni oggetto, corrisponde al suo «dopo»", () => {
    let checked = 0;
    entries.forEach((e, i) => {
      const who = e.object.id;
      const what = `${e.id} ${e.kind}`;
      switch (e.kind) {
        case "person.git_identity_linked":
        case "person.git_identity_unlinked": {
          const identity = (e.after ?? e.before)!;
          if (!latest(i, (x) => (x.kind.startsWith("person.git_identity") ? (x.after ?? x.before) : null)))
            return;
          expect(state.commitAuthorLinks.get(identity), what).toBe(
            e.kind === "person.git_identity_linked" ? who : undefined,
          );
          break;
        }
        case "person.bitbucket_username_set":
          if (!latest(i, (x) => (x.kind === e.kind ? x.object.id : null))) return;
          expect(state.bitbucketUsernames.get(who) ?? null, what).toBe(e.after);
          break;
        case "person.instance_role_changed":
          if (!latest(i, (x) => (x.kind === e.kind ? x.object.id : null))) return;
          expect(instanceRoleOf(who)?.name, what).toBe(e.after);
          break;
        case "person.deactivated":
        case "person.reactivated": {
          if (!latest(i, (x) => (x.kind.startsWith("person.") && x.kind.endsWith("activated") ? x.object.id : null)))
            return;
          const status = accessState().people.find((p) => p.personId === who)?.status;
          expect(status, what).toBe(e.kind === "person.deactivated" ? "deactivated" : "active");
          break;
        }
        case "role.created":
        case "role.updated":
        case "role.deleted": {
          if (!latest(i, (x) => (x.kind.startsWith("role.") ? x.object.id : null))) return;
          const role = roleOf(who);
          if (e.kind === "role.deleted") {
            expect(role, what).toBeUndefined();
            break;
          }
          expect(role?.name, what).toBe(e.after);
          if (e.params.after !== undefined)
            expect([...role!.permissions].sort(), what).toEqual(list(e.params.after).sort());
          for (const p of list(e.params.added)) expect(role!.permissions, what).toContain(p);
          for (const p of list(e.params.removed)) expect(role!.permissions, what).not.toContain(p);
          break;
        }
        case "department.created":
        case "department.deleted":
          if (!latest(i, (x) => (x.kind.startsWith("department.") ? x.object.id : null))) return;
          expect(state.departments.some((d) => d.id === who), what).toBe(
            e.kind === "department.created",
          );
          break;
        case "department.updated": {
          const d = state.departments.find((x) => x.id === who);
          if (!latest(i, (x) => (x.kind === e.kind ? x.object.id : null)) || !d) return;
          expect(`${d.name} ${d.colorToken}`, what).toBe(e.after);
          break;
        }
        case "department.members_changed":
        case "department.home_managers_changed": {
          const a = deptAccess(who);
          if (!a) return;
          const ids = e.kind === "department.members_changed" ? a.memberIds : a.homeManagerIds;
          for (const p of list(e.params.added)) expect(ids, what).toContain(p);
          for (const p of list(e.params.removed)) expect(ids, what).not.toContain(p);
          break;
        }
        case "department.permissions_changed": {
          if (!latest(i, (x) => (x.kind === e.kind ? x.object.id : null))) return;
          expect([...deptAccess(who)!.projectPermissions].sort(), what).toEqual(
            list(e.params.after).sort(),
          );
          break;
        }
        case "member.added":
        case "member.role_changed":
        case "member.removed": {
          const key = (x: (typeof entries)[number]) =>
            x.kind === "member.added" || x.kind === "member.role_changed" || x.kind === "member.removed"
              ? `${x.projectId} ${x.object.id}`
              : null;
          if (!latest(i, key)) return;
          const m = membership(who, e.projectId!);
          if (e.kind === "member.removed") expect(m, what).toBeUndefined();
          else expect(m && roleOf(m.roleId)?.name, what).toBe(e.after);
          break;
        }
        case "member.permission_granted":
        case "member.permission_revoked": {
          const key = (x: (typeof entries)[number]) =>
            x.kind.startsWith("member.permission_")
              ? `${x.projectId} ${x.object.id} ${x.params.permission}`
              : null;
          if (!latest(i, key)) return;
          const has = accessState().grants.some(
            (g) =>
              g.personId === who &&
              g.projectId === e.projectId &&
              g.permission === e.params.permission,
          );
          expect(has, what).toBe(e.kind === "member.permission_granted");
          // Il ruolo nel prima/dopo è quello che la persona ha lì.
          const m = membership(who, e.projectId!);
          expect(m && roleOf(m.roleId)?.name, what).toBe(e.params.role);
          break;
        }
        default:
          return;
      }
      checked += 1;
    });
    expect(checked).toBeGreaterThanOrEqual(15);
  });
});
