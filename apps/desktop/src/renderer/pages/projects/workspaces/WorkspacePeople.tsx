import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAddWorkspaceMember,
  useRemoveWorkspaceMember,
  useSetWorkspaceMemberRole,
  useWorkspaceEffect,
  useWorkspaceMembers,
  type WorkspaceMemberRow,
  type WorkspaceMembersView,
  type WorkspaceOperation,
} from "../../../data/queries";
import { useReauth } from "../../../layout/useReauth";
import { Dialog } from "../../../tasks-ui/Dialog";
import { PageEmpty, PageError } from "../../../tasks-ui/PageStates";
import { useToast } from "../../../tasks-ui/Toast";
import { dangerSolidButton, primaryButton, secondaryButton } from "../../tasks/controls";

/** «Remove from …»: il gesto distruttivo quieto, in rosso. */
const dangerButton =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-critical/40 px-3 text-sm font-medium text-critical hover:bg-critical/8 disabled:opacity-40";
import { useRefusalWords } from "./dialogs";
import { EffectLine, blocks } from "./EffectLine";

// La scheda People di una workspace (shape `workspaces.md`): chi ne fa parte,
// col ruolo di workspace e, sotto, i ruoli per progetto in più. Il pannello
// del membro (`?member=`) mostra il ruolo progetto per progetto con la fonte;
// il ruolo per progetto si cambia in Members del progetto [WS 2]. Invitare
// aggiunge chi ha già un account (D9), di base da Viewer (D3).

type Result = { ok: true } | { ok: false; error: string; reason?: string };

export function WorkspacePeople({ workspace }: { workspace: { id: string; name: string } }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { member?: string };
  const view = useWorkspaceMembers(workspace.id);
  const [inviting, setInviting] = useState(false);
  const data = view.data;
  const open = data?.members.find((m) => m.personId === search.member);
  const setMember = (member: string | undefined) =>
    void navigate({ to: ".", search: ((s: Record<string, unknown>) => ({ ...s, member })) as never });

  if (view.isError)
    return <PageError message={t("workspaces.people.error", { name: workspace.name })} onRetry={() => void view.refetch()} />;
  if (!data) return <div aria-busy="true" className="px-8 py-4 text-sm text-ink-muted" />;

  return (
    <div className="flex min-h-0 flex-1 gap-6 px-8 py-4">
      <div className="flex min-w-0 max-w-[880px] flex-1 flex-col gap-3">
        <div className="flex items-start gap-3">
          <p className="min-w-0 flex-1 text-sm text-ink-muted">{t("workspaces.people.intro", { name: workspace.name })}</p>
          {data.canManage && (
            <button type="button" className={primaryButton} onClick={() => setInviting(true)}>
              {t("workspaces.people.invite", { name: workspace.name })}
            </button>
          )}
        </div>
        {data.members.length === 0 ? (
          <PageEmpty
            title={t("workspaces.people.empty", { name: workspace.name })}
            action={
              data.canManage ? (
                <button type="button" className={primaryButton} onClick={() => setInviting(true)}>
                  {t("workspaces.people.inviteShort")}
                </button>
              ) : undefined
            }
          />
        ) : (
          <ul aria-label={t("workspaces.people.label", { name: workspace.name })} className="border-t border-rule">
            {data.members.map((m) => (
              <MemberRowView key={m.personId} member={m} current={m.personId === search.member} onOpen={() => setMember(m.personId)} />
            ))}
          </ul>
        )}
        <p className="text-sm text-ink-muted">{t("workspaces.people.fullAdmins")}</p>
      </div>
      {open && <MemberPanel workspace={workspace} data={data} member={open} onClose={() => setMember(undefined)} />}
      {inviting && <InviteDialog workspace={workspace} data={data} onClose={() => setInviting(false)} />}
    </div>
  );
}

function MemberRowView({ member, current, onOpen }: { member: WorkspaceMemberRow; current: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  const extra = member.projectRoles.slice(0, 2);
  const more = member.projectRoles.length - extra.length;
  return (
    <li className="border-b border-rule" data-workspace-member={member.personId}>
      <button
        type="button"
        aria-current={current || undefined}
        onClick={onOpen}
        className={`flex w-full items-center gap-3 px-2 py-2 text-left hover:bg-ink/4 ${member.status === "deactivated" ? "text-ink-muted" : ""}`}
      >
        <span aria-hidden="true" className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-ink/10 text-xs font-semibold">
          {member.avatar}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-md">
            <span className="font-semibold">{member.name}</span>
            {member.status === "deactivated" && ` ${t("workspaces.people.deactivated")}`} · {member.roleName}
          </span>
          <span className="block truncate text-sm text-ink-muted">
            {member.email}
            {extra.map((r) => ` · ${t("workspaces.people.plusRole", { role: r.roleName, code: r.code })}`)}
            {more > 0 && ` · ${t("workspaces.people.more", { count: more })}`}
          </span>
        </span>
      </button>
    </li>
  );
}

function MemberPanel({
  workspace,
  data,
  member,
  onClose,
}: {
  workspace: { id: string; name: string };
  data: WorkspaceMembersView;
  member: WorkspaceMemberRow;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const reauth = useReauth();
  const setRole = useSetWorkspaceMemberRole();
  const remove = useRemoveWorkspaceMember();
  const words = useRefusalWords();
  const [roleId, setRoleId] = useState(member.roleId);
  const [removing, setRemoving] = useState(false);
  const [alsoProjects, setAlsoProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roleSelect = useId();
  const changed = roleId !== member.roleId;
  const op = useMemo<WorkspaceOperation | null>(
    () =>
      removing
        ? { kind: "removeMember", workspaceId: workspace.id, personId: member.personId, alsoFromProjects: alsoProjects }
        : changed
          ? { kind: "setMemberRole", workspaceId: workspace.id, personId: member.personId, roleId }
          : null,
    [removing, changed, alsoProjects, roleId, workspace.id, member.personId],
  );
  const effect = useWorkspaceEffect(op).data;
  const firstName = member.name.split(" ")[0] ?? member.name;

  async function save() {
    const r = (await reauth(() => setRole.mutateAsync([workspace.id, member.personId, roleId]), {
      action: t("workspaces.panel.reauthRole", { name: member.name }),
    })) as Result;
    if (!r.ok) return setError(words(r));
    toast.show(t("workspaces.toast.saved"));
  }

  async function confirmRemove() {
    const r = (await reauth(() => remove.mutateAsync([workspace.id, member.personId, alsoProjects]), {
      action: t("workspaces.panel.reauthRemove", { name: member.name, workspace: workspace.name }),
    })) as Result;
    if (!r.ok) return setError(words(r));
    toast.show(t("workspaces.toast.removed", { name: member.name, workspace: workspace.name }));
    onClose();
  }

  const stop = effect?.projects.filter((p) => p.stopSeeing.some((x) => x.personId === member.personId)).map((p) => p.code) ?? [];
  const keeps = member.projectRoles.map((r) => r.code);

  return (
    <aside
      aria-label={member.name}
      data-workspace-panel
      className="flex w-[360px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-rule pl-6"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-ink">{member.name}</h2>
          <p className="text-sm text-ink-muted">{member.email}</p>
        </div>
        <button type="button" className={secondaryButton} onClick={onClose}>
          {t("workspaces.panel.close")}
        </button>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={roleSelect} className="text-sm font-semibold text-ink">
          {t("workspaces.panel.role", { name: workspace.name })}
        </label>
        <select
          id={roleSelect}
          disabled={!data.canManage}
          value={roleId}
          onChange={(e) => setRoleId(e.target.value)}
          className="h-8 rounded-md border border-rule bg-surface px-2 text-sm"
        >
          {data.roleChoices.map((c) => (
            <option key={c.roleId} value={c.roleId} disabled={c.missing.length > 0 && c.roleId !== member.roleId}>
              {c.missing.length > 0 && c.roleId !== member.roleId
                ? t("workspaces.panel.roleMissing", { name: c.name, codes: c.missingIn.join(", ") })
                : t("workspaces.panel.roleChoice", { name: c.name, count: c.permissionCount })}
            </option>
          ))}
        </select>
      </div>
      <section aria-label={t("workspaces.panel.inEach")} className="flex flex-col gap-1">
        <h3 className="heading-group">{t("workspaces.panel.inEach")}</h3>
        <ul className="border-t border-rule">
          {member.projects.map((p) => (
            <li key={p.projectId} className="border-b border-rule py-1.5 text-sm">
              <Link
                to="/p/$code/settings/$section"
                params={{ code: p.code, section: "members" }}
                search={{ member: member.personId } as never}
                className="flex flex-col hover:underline"
              >
                <span>
                  <span className="num font-semibold">{p.code}</span> {p.name}
                </span>
                <span className="text-ink-muted">
                  {p.roles
                    .map((r) =>
                      r.source === "workspace"
                        ? t("workspaces.panel.fromWorkspace", { role: r.roleName })
                        : t("workspaces.panel.fromProject", { role: r.roleName, code: p.code }),
                    )
                    .join(" · ")}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      {data.canManage && (
        <div className="flex flex-col gap-2 border-t border-rule pt-3">
          {!removing ? (
            <button type="button" className={`${dangerButton} self-start`} onClick={() => setRemoving(true)}>
              {t("workspaces.panel.remove", { name: workspace.name })}
            </button>
          ) : (
            <div className="flex flex-col gap-2" data-remove-sheet>
              <p className="text-sm">
                {stop.length > 0
                  ? t("workspaces.panel.removeStops", { name: firstName, codes: stop.join(", ") })
                  : t("workspaces.panel.removeNothing", { name: firstName })}
                {keeps.length > 0 && !alsoProjects && ` ${t("workspaces.panel.removeKeeps", { name: firstName, codes: keeps.join(", ") })}`}
              </p>
              {keeps.length > 0 && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={alsoProjects} onChange={(e) => setAlsoProjects(e.target.checked)} />
                  {t("workspaces.panel.alsoProjects", { name: firstName, codes: keeps.join(", ") })}
                </label>
              )}
              {effect && blocks(effect) && <EffectLine effect={effect} />}
              <div className="flex gap-2">
                <button type="button" className={secondaryButton} onClick={() => setRemoving(false)}>
                  {t("workspaces.dialog.cancel")}
                </button>
                <button type="button" className={dangerSolidButton} disabled={!effect || blocks(effect)} onClick={() => void confirmRemove()}>
                  {t("workspaces.panel.removeConfirm")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {changed && !removing && (
        <div className="sticky bottom-0 flex flex-col gap-2 border-t border-rule bg-surface py-3">
          <EffectLine effect={effect} />
          <div className="flex items-center gap-2">
            <span className="flex-1 text-sm text-ink-muted">{t("workspaces.panel.changes", { count: 1 })}</span>
            <button type="button" className={secondaryButton} onClick={() => setRoleId(member.roleId)}>
              {t("workspaces.panel.discard")}
            </button>
            <button type="button" className={primaryButton} disabled={blocks(effect)} onClick={() => void save()}>
              {t("workspaces.dialog.save")}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
    </aside>
  );
}

function InviteDialog({
  workspace,
  data,
  onClose,
}: {
  workspace: { id: string; name: string };
  data: WorkspaceMembersView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const reauth = useReauth();
  const add = useAddWorkspaceMember();
  const words = useRefusalWords();
  const [personId, setPersonId] = useState("");
  const [roleId, setRoleId] = useState(data.defaultRoleId);
  const [error, setError] = useState<string | null>(null);
  const personSelect = useId();
  const roleSelect = useId();
  const op = useMemo<WorkspaceOperation | null>(
    () => (personId ? { kind: "addMember", workspaceId: workspace.id, personId, roleId } : null),
    [personId, roleId, workspace.id],
  );
  const effect = useWorkspaceEffect(op).data;
  const name = data.addable.find((p) => p.personId === personId)?.name ?? "";
  const seen = effect?.projects.filter((p) => p.startSeeing.some((x) => x.personId === personId)).map((p) => p.code) ?? [];
  const roleName = data.roleChoices.find((c) => c.roleId === roleId)?.name ?? "";

  async function submit() {
    if (!personId || blocks(effect)) return;
    const r = (await reauth(() => add.mutateAsync([workspace.id, personId, roleId]), {
      action: t("workspaces.invite.reauth", { name, workspace: workspace.name }),
    })) as Result;
    if (!r.ok) return setError(words(r));
    toast.show(t("workspaces.toast.joined", { name, workspace: workspace.name, role: roleName }));
    onClose();
  }

  return (
    <Dialog
      title={t("workspaces.people.invite", { name: workspace.name })}
      onClose={onClose}
      width={440}
      footer={(dismiss) => (
        <>
          <button type="button" className={secondaryButton} onClick={dismiss}>
            {t("workspaces.dialog.cancel")}
          </button>
          <button type="button" className={primaryButton} disabled={!personId || blocks(effect)} onClick={() => void submit()}>
            {t("workspaces.invite.submit")}
          </button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor={personSelect} className="text-sm font-semibold text-ink">
            {t("workspaces.invite.person")}
          </label>
          <select
            id={personSelect}
            data-autofocus
            value={personId}
            onChange={(e) => setPersonId(e.target.value)}
            className="h-8 rounded-md border border-rule bg-surface px-2 text-sm"
          >
            <option value="">{t("workspaces.invite.choose")}</option>
            {data.addable.map((p) => (
              // I reparti della persona porterebbero permessi che chi invita non ha: spenta col motivo.
              <option key={p.personId} value={p.personId} disabled={(p.missing ?? []).length > 0}>
                {(p.missing ?? []).length > 0 ? t("workspaces.invite.departmentMissing", { name: p.name }) : p.name}
              </option>
            ))}
            {data.fullAdmins.map((p) => (
              <option key={p.personId} value={p.personId} disabled>
                {t("workspaces.invite.fullAdmin", { name: p.name })}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={roleSelect} className="text-sm font-semibold text-ink">
            {t("workspaces.invite.role")}
          </label>
          <select
            id={roleSelect}
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
            className="h-8 rounded-md border border-rule bg-surface px-2 text-sm"
          >
            {data.roleChoices.map((c) => (
              <option key={c.roleId} value={c.roleId} disabled={c.missing.length > 0}>
                {c.missing.length > 0
                  ? t("workspaces.panel.roleMissing", { name: c.name, codes: c.missingIn.join(", ") })
                  : t("workspaces.panel.roleChoice", { name: c.name, count: c.permissionCount })}
              </option>
            ))}
          </select>
        </div>
        {personId && seen.length > 0 && (
          <p className="text-sm text-ink-muted" data-invite-effect>
            {t("workspaces.invite.willSee", { name: name.split(" ")[0], count: seen.length, codes: seen.join(", ") })}
          </p>
        )}
        {effect && blocks(effect) && <EffectLine effect={effect} />}
        <button
          type="button"
          className="self-start text-sm underline"
          onClick={() => {
            onClose();
            void navigate({ to: "/admin/$section", params: { section: "people" }, search: { invite: "1", inviteWorkspace: workspace.id } as never });
          }}
        >
          {t("workspaces.invite.newAccount")}
        </button>
        {error && (
          <p role="alert" className="text-sm text-critical">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
