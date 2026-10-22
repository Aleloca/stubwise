import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDeleteButton } from "../../components/confirm-delete-button";
import { FormError, TextField } from "../../components/field";
import {
  createRole,
  deleteRole,
  duplicateRole,
  updateRole,
  type Role,
  type RoleScope,
} from "../../lib/api";
import { meQueryOptions } from "../../lib/auth";
import { permissionGroupsFor } from "../../lib/permission-groups";
import { rolesQueryOptions } from "../../lib/queries";
import { translateRoleError } from "../../lib/role-errors";

/**
 * Impostazioni → Ruoli (`roles.manage`, guardia nel router): il catalogo dei
 * ruoli, diviso per tipo (d'istanza, di progetto). Si crea, duplica, rinomina,
 * cambia i permessi ed elimina; le regole (anti-escalation, ruolo in uso,
 * ultimo full admin, preset richiesti dal sistema) le decide il server, e qui
 * i suoi errori si mostrano in chiaro accanto al ruolo.
 */
export function SettingsRolesPage() {
  const { t } = useTranslation();
  const { data: roles, isPending, isError, error } = useQuery(rolesQueryOptions());

  return (
    <div className="flex flex-col gap-8">
      <p className="text-sm text-fg-muted">{t("settings:roles.intro")}</p>
      {isPending ? (
        <p className="font-mono text-[12px] text-fg-faint">{t("settings:roles.loading")}</p>
      ) : isError ? (
        <FormError message={translateRoleError(error, t)} />
      ) : (
        (["instance", "project"] as const).map((scope) => (
          <RoleScopeSection
            key={scope}
            scope={scope}
            roles={roles.filter((role) => role.scope === scope)}
          />
        ))
      )}
    </div>
  );
}

const sectionTitleClass =
  "font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase";
const actionButton =
  "tap rounded-sm border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.14em] text-fg-muted uppercase transition-colors hover:border-signal-dim/40 hover:text-signal disabled:cursor-not-allowed disabled:opacity-50";

/** Dopo ogni modifica: il catalogo, e `/me` — i propri permessi possono essere cambiati. */
function useInvalidateRoles() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["roles"] });
    void queryClient.invalidateQueries({ queryKey: meQueryOptions.queryKey });
  };
}

function RoleScopeSection({ scope, roles }: { scope: RoleScope; roles: Role[] }) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const title = t(`settings:roles.scope.${scope}`);

  return (
    <section aria-label={title} className="rounded-sm border border-line bg-ink-900">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h2 className={sectionTitleClass}>{title}</h2>
          <p className="mt-1 font-mono text-[11px] text-fg-faint">
            {t(`settings:roles.scopeHint.${scope}`)}
          </p>
        </div>
        {!creating && (
          <button type="button" onClick={() => setCreating(true)} className={actionButton}>
            {t(`settings:roles.new.${scope}`)}
          </button>
        )}
      </header>

      {creating && (
        <div className="border-b border-line px-4 py-4">
          <RoleEditor scope={scope} onDone={() => setCreating(false)} />
        </div>
      )}

      {roles.length === 0 ? (
        <p className="px-4 py-4 font-mono text-[12px] text-fg-faint">{t("settings:roles.empty")}</p>
      ) : (
        <ul className="divide-y divide-line">
          {roles.map((role) => (
            <RoleRow key={role.id} role={role} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RoleRow({ role }: { role: Role }) {
  const { t } = useTranslation();
  const invalidate = useInvalidateRoles();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Il web non parsa: un server più vecchio potrebbe non mandarlo.
  const assigned = role.assignmentCount ?? 0;
  // I preset `Admin` e `User` servono ancora al sistema (ruling R9): il server
  // ne rifiuta sempre l'eliminazione, quindi il bottone non c'è. Un ruolo in
  // uso ha il bottone spento col motivo. In entrambi i casi l'errore del
  // server (409) resta la rete di sicurezza, se il conteggio è vecchio.
  const systemPreset = role.presetKey === "admin" || role.presetKey === "user";

  const duplicateMutation = useMutation({
    mutationFn: () => duplicateRole(role.id),
    onSuccess: invalidate,
    onError: (cause) => setError(translateRoleError(cause, t)),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteRole(role.id),
    onSuccess: invalidate,
    onError: (cause) => setError(translateRoleError(cause, t)),
  });

  return (
    <li aria-label={role.name} className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-mono text-[13px] text-fg">{role.name}</span>
          {role.presetKey && (
            <span className="shrink-0 rounded-sm border border-line-strong px-1.5 py-0.5 font-mono text-[10px] tracking-[0.12em] text-fg-faint uppercase">
              {t("settings:roles.preset")}
            </span>
          )}
          <span className="font-mono text-[11px] text-fg-faint">
            {t("settings:roles.permissionCount", { count: role.permissions.length })}
            {" · "}
            {t(`settings:roles.assigned.${role.scope}`, { count: assigned })}
          </span>
        </div>
        {!editing && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              aria-label={t("settings:roles.editLabel", { name: role.name })}
              onClick={() => {
                setError(null);
                setEditing(true);
              }}
              className={actionButton}
            >
              {t("settings:roles.edit")}
            </button>
            <button
              type="button"
              aria-label={t("settings:roles.duplicateLabel", { name: role.name })}
              disabled={duplicateMutation.isPending}
              onClick={() => {
                setError(null);
                duplicateMutation.mutate();
              }}
              className={actionButton}
            >
              {t("settings:roles.duplicate")}
            </button>
            {systemPreset ? null : assigned > 0 ? (
              <button
                type="button"
                disabled
                aria-label={t("settings:roles.deleteLabel", { name: role.name })}
                className="rounded-sm border border-danger/30 bg-ink-950/70 px-2.5 py-1 font-mono text-[11px] tracking-[0.08em] text-danger uppercase disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("settings:roles.delete")}
              </button>
            ) : (
              <ConfirmDeleteButton
                label={t("settings:roles.delete")}
                labelAria={t("settings:roles.deleteLabel", { name: role.name })}
                confirmLabel={t("settings:roles.confirmDelete")}
                confirmAria={t("settings:roles.confirmDeleteLabel", { name: role.name })}
                pending={deleteMutation.isPending}
                onConfirm={() => {
                  setError(null);
                  deleteMutation.mutate();
                }}
              />
            )}
          </div>
        )}
      </div>
      {!editing && (systemPreset || assigned > 0) && (
        <p className="font-mono text-[11px] text-fg-faint">
          {systemPreset
            ? t("settings:roles.systemPresetHint")
            : t("settings:roles.inUseHint", { count: assigned })}
        </p>
      )}
      {editing && <RoleEditor scope={role.scope} role={role} onDone={() => setEditing(false)} />}
      <FormError message={error} />
    </li>
  );
}

/**
 * Form di un ruolo: nome e caselle dei permessi del suo tipo, raggruppate per
 * area. Senza `role` crea, con `role` modifica (il tipo non cambia mai).
 */
function RoleEditor({
  scope,
  role,
  onDone,
}: {
  scope: RoleScope;
  role?: Role;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const invalidate = useInvalidateRoles();
  const [name, setName] = useState(role?.name ?? "");
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(role?.permissions ?? []),
  );
  const [error, setError] = useState<string | null>(null);
  const idPrefix = `role-${role?.id ?? `new-${scope}`}`;

  const mutation = useMutation({
    mutationFn: () => {
      const permissions = [...selected];
      return role
        ? updateRole(role.id, { name: name.trim(), permissions })
        : createRole({ name: name.trim(), scope, permissions });
    },
    onSuccess: () => {
      invalidate();
      onDone();
    },
    onError: (cause) => setError(translateRoleError(cause, t)),
  });

  function toggle(permission: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    mutation.mutate();
  }

  const fullAdmin = scope === "instance" && selected.has("instance.full_admin");

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <TextField
        id={`${idPrefix}-name`}
        label={t("settings:roles.name")}
        value={name}
        maxLength={80}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {permissionGroupsFor(scope).map((group) => (
          <fieldset key={group.id} className="flex flex-col gap-1.5">
            <legend className="mb-1 font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
              {t(`settings:roles.groups.${group.id}`)}
            </legend>
            {group.permissions.map((permission) => (
              <label
                key={permission}
                className="flex items-start gap-2 font-mono text-[12px] text-fg-muted"
              >
                <input
                  type="checkbox"
                  checked={selected.has(permission)}
                  onChange={() => toggle(permission)}
                  className="mt-0.5 accent-[var(--color-signal)]"
                />
                <span>{t(`permissions:label.${permission}`)}</span>
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      {fullAdmin && (
        <p className="font-mono text-[11px] text-signal">{t("settings:roles.fullAdminHint")}</p>
      )}
      <FormError message={error} />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={mutation.isPending || name.trim() === ""}
          className="rounded-sm bg-signal px-4 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
        >
          {mutation.isPending ? t("settings:roles.saving") : t("settings:roles.save")}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:text-fg"
        >
          {t("settings:roles.cancel")}
        </button>
      </div>
    </form>
  );
}
