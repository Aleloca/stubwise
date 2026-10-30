import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAdminPeople,
  useCreateRole,
  useDeleteRole,
  useDuplicateRole,
  useProjects,
  useRoles,
  type RoleView,
} from "../../data/queries";
import { useReauth } from "../../layout/useReauth";
import { Dialog, inputClass } from "../../tasks-ui/Dialog";
import { itemClass } from "../../tasks-ui/Menu";
import { PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { OpenCircleGlyph } from "../preferences/glyphs";
import { ArmedButton, RowMenu, WriteError, refusalOf } from "../preferences/parts";
import { Chevron, MenuButton, dangerSolidButton, primaryButton, secondaryButton } from "../tasks/controls";
import { RoleOptions } from "./InviteDialog";
import { useRefusalWords, type UiRefusal } from "./parts";

// Roles (shape admin-roles-members.md, «Roles»): i ruoli d'istanza e di
// progetto in due gruppi, con chi li ha (R-G5: solo persone e progetti che
// chi guarda vede), e il «⋯» di riga con Duplicate e Delete…. La voce c'è
// solo con `roles.manage` (`adminSections`), quindi la pagina non ha uno
// stato «in lettura». Cosa si può copiare o eliminare lo dice il livello dati
// (`copyMissing`, `deleteBlock`).

type Scope = RoleView["scope"];

export function RolesPage() {
  const { t } = useTranslation();
  const roles = useRoles();
  const [creating, setCreating] = useState<Scope | null>(null);
  return (
    <section className="page-header pb-16 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <div className="max-w-[880px]">
        <h1 className="text-2xl font-semibold tracking-[-0.01em] text-ink">
          {t("admin.sections.roles")}
        </h1>
        <p className="mt-2 max-w-[62ch] text-md text-pretty text-ink-muted">
          {t("admin.roles.intro")}
        </p>
        {roles.isPending ? (
          <RolesSkeleton />
        ) : roles.isError ? (
          <div className="mt-6 border-t border-rule">
            <PageError message={t("admin.roles.loadError")} onRetry={() => void roles.refetch()} />
          </div>
        ) : (
          (["instance", "project"] as const).map((scope) => (
            <RoleGroup
              key={scope}
              scope={scope}
              roles={roles.data.filter((r) => r.scope === scope)}
              onNew={() => setCreating(scope)}
            />
          ))
        )}
        <p className="mt-6 flex items-start gap-1.5 text-sm text-ink-muted">
          <span className="mt-[3px] shrink-0">
            <OpenCircleGlyph size={12} />
          </span>
          {t("admin.roles.claudeNote")}
        </p>
      </div>
      {creating && (
        <NewRoleDialog
          scope={creating}
          roles={(roles.data ?? []).filter((r) => r.scope === creating)}
          onClose={() => setCreating(null)}
        />
      )}
    </section>
  );
}

function RolesSkeleton() {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      {[0, 1].map((g) => (
        <div key={g} className="mt-8">
          <span className={`block h-3 w-28 ${bar}`} />
          <div className="mt-2 border-t border-rule">
            {[40, 28, 34, 30, 44, 26].map((w, i) => (
              <div key={i} className="flex h-11 items-center gap-4 border-b border-rule">
                <span className={`h-2.5 ${bar}`} style={{ width: `${w}%` }} />
                <span className={`ml-auto h-2.5 w-20 ${bar}`} />
                <span className={`h-2.5 w-16 ${bar}`} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Un gruppo (INSTANCE ROLES, PROJECT ROLES) con «New … role» a destra. */
function RoleGroup({ scope, roles, onNew }: { scope: Scope; roles: RoleView[]; onNew: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-8">
      <div className="flex items-center gap-3 pb-1.5">
        <h2 id={id} className="heading-group min-w-0 flex-1">
          {t(`admin.roles.groups.${scope}`)}
        </h2>
        <button type="button" className={`${secondaryButton} h-7 px-2.5`} onClick={onNew}>
          {t(`admin.roles.new.${scope}`)}
        </button>
      </div>
      <ul aria-labelledby={id} className="border-t border-rule">
        {roles.map((r) => (
          <RoleRow key={r.id} role={r} />
        ))}
      </ul>
    </section>
  );
}

/**
 * La riga di un ruolo (44 px): il nome porta alla pagina del ruolo (tutta la
 * riga si clicca), poi «Preset», i permessi, chi lo ha e il «⋯». Chi lo ha:
 * per un ruolo d'istanza il link a People filtrato; per uno di progetto le
 * appartenenze, che si aprono sotto la riga.
 */
function RoleRow({ role }: { role: RoleView }) {
  const { t } = useTranslation();
  const [showHolders, setShowHolders] = useState(false);
  const listId = useId();
  const count = role.peopleCount;
  const lift = "relative z-10";
  return (
    <li className="border-b border-rule">
      <div className="relative flex min-h-11 items-center gap-4 rounded-md px-1 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4">
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <Link
            to="/admin/roles/$roleId"
            params={{ roleId: role.id }}
            className="min-w-0 truncate text-md font-medium text-ink after:absolute after:inset-0 after:rounded-md after:content-['']"
          >
            {role.name}
          </Link>
          {role.preset && (
            <span className="shrink-0 text-xs text-ink-muted">{t("admin.roles.preset")}</span>
          )}
        </span>
        <span className="num w-28 shrink-0 text-right text-sm text-ink-muted">
          {t("admin.roles.permissions", { count: role.permissions.length })}
        </span>
        <span className="w-32 shrink-0 text-right text-sm">
          {role.scope === "instance" ? (
            count > 0 ? (
              <Link
                to="/admin/$section"
                params={{ section: "people" }}
                search={{ roles: role.id } as never}
                className={`${lift} num text-ink-muted underline-offset-2 hover:text-ink hover:underline`}
              >
                {t("admin.roles.people", { count })}
              </Link>
            ) : (
              <span className="num text-ink-faint">{t("admin.roles.people", { count })}</span>
            )
          ) : count > 0 ? (
            <button
              type="button"
              aria-expanded={showHolders}
              aria-controls={listId}
              onClick={() => setShowHolders((s) => !s)}
              className={`${lift} num inline-flex items-center gap-1 rounded-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline`}
            >
              {t("admin.roles.memberships", { count })}
              <span className={`transition-transform duration-[var(--duration-fast)] ${showHolders ? "rotate-180" : ""}`}>
                <Chevron />
              </span>
            </button>
          ) : (
            <span className="num text-ink-faint">{t("admin.roles.memberships", { count })}</span>
          )}
        </span>
        <span className={lift}>
          <RoleMenu role={role} />
        </span>
      </div>
      {showHolders && (
        <div id={listId} className="pb-2 pl-1">
          <HolderList role={role} />
        </div>
      )}
    </li>
  );
}

/**
 * Chi ha il ruolo: persona · progetto, coi soli progetti e le sole persone
 * che chi guarda vede (le appartenenze le filtra già il livello dati).
 */
export function HolderList({ role }: { role: RoleView }) {
  const { t } = useTranslation();
  const people = useAdminPeople({ statuses: ["active", "deactivated"] }).data ?? [];
  const projects = useProjects().data ?? [];
  const nameOf = (id: string) => people.find((p) => p.personId === id)?.name ?? id;
  const codeOf = (id: string | null) => projects.find((p) => p.id === id)?.code ?? "";
  const rows = [...role.holders].sort((a, b) =>
    `${nameOf(a.personId)} ${codeOf(a.projectId)}`.localeCompare(
      `${nameOf(b.personId)} ${codeOf(b.projectId)}`,
    ),
  );
  return (
    <ul aria-label={t("admin.roles.holdersLabel", { role: role.name })} className="flex flex-col">
      {rows.map((h) => (
        <li key={`${h.personId}:${h.projectId ?? ""}`} className="flex h-8 items-center gap-3 text-sm">
          <Link
            to="/admin/people/$personId"
            params={{ personId: h.personId }}
            className="min-w-0 truncate text-ink underline-offset-2 hover:underline"
          >
            {nameOf(h.personId)}
          </Link>
          {h.projectId && (
            <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink-muted">
              {codeOf(h.projectId)}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

type RoleDialog = "deleteFree" | "deleteInUse" | null;

/** Il «⋯» di un ruolo: Duplicate, e Delete… dove ha senso (preset: spento col motivo). */
export function RoleMenu({ role, afterDelete }: { role: RoleView; afterDelete?: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const duplicate = useDuplicateRole();
  const reauth = useReauth();
  const refusalWords = useRefusalWords();
  const [dialog, setDialog] = useState<RoleDialog>(null);
  const [error, setError] = useState<string | null>(null);
  const copyBlocked = role.copyMissing.length > 0;

  async function onDuplicate() {
    setError(null);
    const result = await reauth(() => duplicate.mutateAsync([role.id]), {
      action: t("admin.roles.duplicateAction", { role: role.name }),
    }).catch(() => null);
    if (result === null) return setError(t("admin.refusal.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal) return setError(refusalWords(refusal, { what: role.name }));
    void navigate({
      to: "/admin/roles/$roleId",
      params: { roleId: (result as { roleId: string }).roleId },
    });
  }

  const disabledItem = `${itemClass} cursor-default flex-col items-start gap-0 hover:bg-transparent`;
  return (
    <span className="flex flex-col items-end">
      <RowMenu label={t("admin.roles.more", { role: role.name })}>
        {(close) => (
          <>
            <button
              type="button"
              role="menuitem"
              aria-disabled={copyBlocked || undefined}
              className={copyBlocked ? disabledItem : itemClass}
              onClick={() => {
                if (copyBlocked) return;
                close(true);
                void onDuplicate();
              }}
            >
              <span className={copyBlocked ? "text-ink-muted" : undefined}>
                {t("admin.roles.duplicate")}
              </span>
              {copyBlocked && (
                <span className="text-xs text-ink-muted">{t("admin.person.instanceRole.beyond")}</span>
              )}
            </button>
            {role.deleteBlock === "preset" ? (
              <button type="button" role="menuitem" aria-disabled="true" className={disabledItem}>
                <span className="text-ink-muted">{t("admin.roles.delete")}</span>
                <span className="text-xs text-ink-muted">{t("admin.roles.presetNoDelete")}</span>
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                className={itemClass}
                onClick={() => {
                  close(false);
                  setDialog(role.deleteBlock === "in_use" ? "deleteInUse" : "deleteFree");
                }}
              >
                {t("admin.roles.delete")}
              </button>
            )}
          </>
        )}
      </RowMenu>
      {error && <WriteError message={error} />}
      {dialog === "deleteInUse" && <RoleInUseDialog role={role} onClose={() => setDialog(null)} />}
      {dialog === "deleteFree" && (
        <DeleteRoleDialog role={role} onClose={() => setDialog(null)} onDeleted={afterDelete} />
      )}
    </span>
  );
}

/** «Release manager is still used»: chi lo ha, e cosa fare prima. */
function RoleInUseDialog({ role, onClose }: { role: RoleView; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={t("admin.roles.inUse.title", { role: role.name })}
      width={440}
      onClose={onClose}
      footer={
        <button type="button" className={secondaryButton} onClick={onClose}>
          {t("admin.roles.inUse.close")}
        </button>
      }
    >
      {role.holders.length > 0 ? (
        <HolderList role={role} />
      ) : (
        <p className="text-sm text-ink-muted">{t("admin.roles.inUse.hidden")}</p>
      )}
      <p className="mt-3 text-sm text-ink">{t("admin.roles.inUse.body")}</p>
    </Dialog>
  );
}

/** «Delete Auditor? No one has it.»: conferma a due tempi, riconferma, poi Roles e il toast. */
function DeleteRoleDialog({
  role,
  onClose,
  onDeleted,
}: {
  role: RoleView;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const del = useDeleteRole();
  const reauth = useReauth();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const [error, setError] = useState<string | null>(null);

  async function onDelete() {
    setError(null);
    const result = await reauth(() => del.mutateAsync([role.id]), {
      action: t("admin.roles.deleteAction", { role: role.name }),
    }).catch(() => null);
    if (result === null) return setError(t("admin.refusal.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal) return setError(refusalWords(refusal, { what: role.name }));
    toast.show(t("admin.roles.deleted"));
    onClose();
    onDeleted?.();
    void navigate({ to: "/admin/$section", params: { section: "roles" } });
  }

  return (
    <Dialog
      title={t("admin.roles.deleteTitle", { role: role.name })}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("admin.roles.cancel")}
          </button>
          <ArmedButton
            label={t("admin.roles.deleteConfirm")}
            sureLabel={t("admin.roles.deleteSure")}
            className={dangerSolidButton}
            onConfirm={() => void onDelete()}
          />
        </>
      }
    >
      <p className="text-md text-ink">{t("admin.roles.deleteBody")}</p>
      {error && <WriteError message={error} />}
    </Dialog>
  );
}

/**
 * «New instance role» / «New project role»: nome e punto di partenza (vuoto
 * o un ruolo dello stesso livello; quelli oltre chi agisce sono spenti col
 * motivo, da `copyMissing`). Crea con la riconferma e apre la sua pagina.
 */
function NewRoleDialog({
  scope,
  roles,
  onClose,
}: {
  scope: Scope;
  roles: RoleView[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const create = useCreateRole();
  const reauth = useReauth();
  const refusalWords = useRefusalWords();
  const [name, setName] = useState("");
  const [from, setFrom] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const fromRole = roles.find((r) => r.id === from);
  const EMPTY = "";
  const choices = [
    { roleId: EMPTY, name: t("admin.roles.newDialog.empty"), permissionCount: 0, missing: [] },
    ...roles.map((r) => ({
      roleId: r.id,
      name: r.name,
      permissionCount: r.permissions.length,
      missing: r.copyMissing,
    })),
  ];

  async function onCreate() {
    setError(null);
    const result = await reauth(
      () => create.mutateAsync([{ name, scope, from: from || undefined }]),
      { action: t("admin.roles.newDialog.action") },
    ).catch(() => null);
    if (result === null) return setError(t("admin.refusal.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal) {
      if (refusal.error === "invalid")
        return setError(t(`admin.roles.nameErrors.${refusal.reason === "name_taken" ? "taken" : "empty"}`));
      return setError(refusalWords(refusal, { what: fromRole?.name }));
    }
    onClose();
    void navigate({
      to: "/admin/roles/$roleId",
      params: { roleId: (result as { roleId: string }).roleId },
    });
  }

  return (
    <Dialog
      title={t(`admin.roles.new.${scope}`)}
      width={440}
      onClose={onClose}
      confirmDiscard={
        name.trim()
          ? {
              message: t("admin.roles.newDialog.discard"),
              keep: t("admin.roles.newDialog.keep"),
              discard: t("admin.roles.newDialog.discardAction"),
            }
          : undefined
      }
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("admin.roles.cancel")}
          </button>
          <button
            type="button"
            className={`${primaryButton} disabled:opacity-40`}
            disabled={!name.trim() || create.isPending}
            onClick={() => void onCreate()}
          >
            {t("admin.roles.newDialog.create")}
          </button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void onCreate();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-sm font-medium text-ink">
            {t("admin.roles.newDialog.name")}
          </label>
          <input
            id={nameId}
            data-autofocus
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">{t("admin.roles.newDialog.startFrom")}</span>
          <MenuButton
            menuLabel={t("admin.roles.newDialog.startFrom")}
            className={`${secondaryButton} justify-between`}
            wrapperClassName="flex"
            label={
              <>
                <span className="min-w-0 truncate">
                  {fromRole?.name ?? t("admin.roles.newDialog.empty")}
                </span>
                <Chevron />
              </>
            }
          >
            {(close) => (
              <RoleOptions
                roles={choices}
                value={from}
                onPick={(id) => {
                  setFrom(id);
                  close();
                }}
              />
            )}
          </MenuButton>
        </div>
        {error && <WriteError message={error} />}
      </form>
    </Dialog>
  );
}
