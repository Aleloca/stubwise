import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Avatar } from "./avatar";
import { ConfirmDeleteButton } from "./confirm-delete-button";
import { FormError, SelectField } from "./field";
import {
  putProjectMember,
  removeProjectMember,
  type ProjectMember,
  type Role,
} from "../lib/api";
import { meQueryOptions } from "../lib/auth";
import { useCan } from "../lib/permissions";
import {
  projectMembersQueryOptions,
  rolesQueryOptions,
  usersQueryOptions,
} from "../lib/queries";
import { translateRoleError } from "../lib/role-errors";

/**
 * Membri di un progetto: chi lo vede e con quale ruolo. L'elenco lo legge ogni
 * membro; aggiungere, cambiare ruolo e togliere chiede `project.members.manage`
 * in QUESTO progetto. Le regole (anti-escalation, non toccare chi ha più
 * permessi di te) le decide il server, e i suoi errori si mostrano accanto
 * alla riga. I full admin vedono ogni progetto senza comparire qui.
 */
export function ProjectMembersSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const canManage = useCan("project.members.manage", projectId);
  const members = useQuery(projectMembersQueryOptions(projectId));
  // Ruoli di progetto e utenti servono solo a chi gestisce: per gli altri la
  // GET dei ruoli risponderebbe 403.
  const roles = useQuery({ ...rolesQueryOptions("project"), enabled: canManage });

  if (members.isPending) {
    return <p className="font-mono text-[12px] text-fg-faint">{t("projects:members.loading")}</p>;
  }
  if (members.isError) {
    return <FormError message={translateRoleError(members.error, t)} />;
  }

  const projectRoles = roles.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      {members.data.length === 0 ? (
        <p className="font-mono text-[12px] text-fg-faint">{t("projects:members.empty")}</p>
      ) : (
        <ul className="rounded-sm border border-line bg-ink-900">
          {members.data.map((member) => (
            <MemberRow
              key={member.userId}
              projectId={projectId}
              member={member}
              canManage={canManage && projectRoles.length > 0}
              roles={projectRoles}
            />
          ))}
        </ul>
      )}
      <p className="font-mono text-[11px] text-fg-faint">{t("projects:members.fullAdminHint")}</p>
      {canManage && projectRoles.length > 0 && (
        <AddMemberForm projectId={projectId} members={members.data} roles={projectRoles} />
      )}
    </div>
  );
}

function useInvalidateMembers(projectId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: projectMembersQueryOptions(projectId).queryKey });
    // I propri permessi (e i progetti visibili) possono essere cambiati.
    void queryClient.invalidateQueries({ queryKey: meQueryOptions.queryKey });
  };
}

function MemberRow({
  projectId,
  member,
  canManage,
  roles,
}: {
  projectId: string;
  member: ProjectMember;
  canManage: boolean;
  roles: Role[];
}) {
  const { t } = useTranslation();
  const invalidate = useInvalidateMembers(projectId);
  const [error, setError] = useState<string | null>(null);

  const roleMutation = useMutation({
    mutationFn: (roleId: string) => putProjectMember(projectId, member.userId, roleId),
    onSuccess: invalidate,
    onError: (cause) => setError(translateRoleError(cause, t)),
  });
  const removeMutation = useMutation({
    mutationFn: () => removeProjectMember(projectId, member.userId),
    onSuccess: invalidate,
    onError: (cause) => setError(translateRoleError(cause, t)),
  });

  return (
    <li
      aria-label={member.email}
      className="flex flex-col gap-2 border-b border-line px-4 py-3 last:border-b-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <Avatar src={member.avatarUrl} label={member.email} size={20} />
          <span className="truncate font-mono text-[13px] text-fg">{member.email}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {canManage ? (
            <select
              aria-label={t("projects:members.roleOf", { email: member.email })}
              value={member.roleId}
              disabled={roleMutation.isPending}
              onChange={(event) => {
                setError(null);
                roleMutation.mutate(event.target.value);
              }}
              className="tap rounded-sm border border-line-strong bg-ink-950 px-2 py-1 font-mono text-[11px] text-fg-muted transition-colors hover:border-signal-dim/40 disabled:opacity-50"
            >
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="rounded-sm border border-line-strong px-1.5 py-0.5 font-mono text-[10px] tracking-[0.12em] text-fg-muted uppercase">
              {member.roleName}
            </span>
          )}
          {canManage && (
            <ConfirmDeleteButton
              label={t("projects:members.remove")}
              labelAria={t("projects:members.removeLabel", { email: member.email })}
              confirmLabel={t("projects:members.confirmRemove")}
              confirmAria={t("projects:members.confirmRemoveLabel", { email: member.email })}
              pending={removeMutation.isPending}
              onConfirm={() => {
                setError(null);
                removeMutation.mutate();
              }}
            />
          )}
        </span>
      </div>
      <FormError message={error} />
    </li>
  );
}

function AddMemberForm({
  projectId,
  members,
  roles,
}: {
  projectId: string;
  members: ProjectMember[];
  roles: Role[];
}) {
  const { t } = useTranslation();
  const invalidate = useInvalidateMembers(projectId);
  // Chi aggiungere: gli utenti che chi gestisce vede, meno i membri attuali.
  const users = useQuery(usersQueryOptions);
  const memberIds = new Set(members.map((member) => member.userId));
  const candidates = (users.data ?? []).filter((user) => !memberIds.has(user.id));
  const [userId, setUserId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => putProjectMember(projectId, userId, roleId),
    onSuccess: () => {
      setUserId("");
      invalidate();
    },
    onError: (cause) => setError(translateRoleError(cause, t)),
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    mutation.mutate();
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label={t("projects:members.addTitle")}
      className="flex flex-col gap-3 rounded-sm border border-line bg-ink-950/40 p-4"
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto] sm:items-end">
        <SelectField
          id={`add-member-user-${projectId}`}
          label={t("projects:members.user")}
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          options={[
            { value: "", label: t("projects:members.pickUser") },
            ...candidates.map((user) => ({ value: user.id, label: user.email })),
          ]}
        />
        <SelectField
          id={`add-member-role-${projectId}`}
          label={t("projects:members.role")}
          value={roleId}
          onChange={(event) => setRoleId(event.target.value)}
          options={[
            { value: "", label: t("projects:members.pickRole") },
            ...roles.map((role) => ({ value: role.id, label: role.name })),
          ]}
        />
        <button
          type="submit"
          disabled={mutation.isPending || userId === "" || roleId === ""}
          className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mutation.isPending ? t("projects:members.adding") : t("projects:members.add")}
        </button>
      </div>
      <FormError message={error} />
    </form>
  );
}
