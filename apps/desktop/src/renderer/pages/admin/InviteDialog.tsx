import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useCreateInvite,
  useInviteChoices,
  type InviteChoices,
  type RoleChoice,
} from "../../data/queries";
import { useReauth } from "../../layout/useReauth";
import { Dialog, DialogField, inputClass, selectButtonClass } from "../../tasks-ui/Dialog";
import { MenuGroup, MenuNote, RadioDot, itemClass } from "../../tasks-ui/Menu";
import { ErrorLine } from "../entry/parts";
import { SecretOnce } from "../preferences/SecretOnce";
import { Chevron, MenuButton, primaryButton, secondaryButton } from "../tasks/controls";
import { refusalOf, rowButton } from "../preferences/parts";
import { useMissingWords, useRefusalWords, useShortDate, type UiRefusal } from "./parts";

// «Invite someone» (shape admin-people.md, «Inviti»): email, ruolo d'istanza
// (di base User) e i progetti, ognuno col suo ruolo. Si offrono solo i
// progetti dove chi invita gestisce i membri, e i ruoli che contengono
// permessi che chi invita non ha sono spenti col motivo: le scelte e ciò che
// manca li dice il livello dati (`getInviteChoices`). «Create invite» passa
// dalla riconferma; il link si vede una volta, qui, con «Send it yourself».

interface ProjectPick {
  projectId: string;
  roleId: string;
}

export function InviteDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const choices = useInviteChoices();
  const [secret, setSecret] = useState<{ email: string; link: string; expiresAt: string } | null>(
    null,
  );
  const date = useShortDate();
  // Il modulo ha il suo piede (Cancel · Create invite); il link e gli stati no.
  if (choices.isSuccess && !secret)
    return <InviteForm choices={choices.data} onClose={onClose} onCreated={setSecret} />;
  return (
    <Dialog title={t("admin.invite.title")} onClose={onClose} width={560}>
      {secret ? (
        <SecretOnce
          title={t("admin.invite.secretTitle", { email: secret.email })}
          value={secret.link}
          onDone={onClose}
        >
          <p className="text-ink">{t("admin.invite.sendYourself")}</p>
          <p>{t("admin.invite.expiresIn", { date: date(secret.expiresAt) })}</p>
        </SecretOnce>
      ) : choices.isError ? (
        <ErrorLine>{t("admin.invite.loadError")}</ErrorLine>
      ) : (
        <p role="status" className="text-sm text-ink-muted">
          {t("taskUi.states.loading")}
        </p>
      )}
    </Dialog>
  );
}

function InviteForm({
  choices,
  onClose,
  onCreated,
}: {
  choices: InviteChoices;
  onClose: () => void;
  onCreated: (s: { email: string; link: string; expiresAt: string }) => void;
}) {
  const { t } = useTranslation();
  const create = useCreateInvite();
  const reauth = useReauth();
  const refusalWords = useRefusalWords();
  const emailId = useId();
  const emailErrorId = useId();
  const [email, setEmail] = useState("");
  const [instanceRoleId, setInstanceRoleId] = useState(choices.defaultInstanceRoleId);
  const [projects, setProjects] = useState<ProjectPick[]>([]);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const instanceRole = choices.instanceRoles.find((r) => r.roleId === instanceRoleId);
  const remaining = choices.projects.filter((p) => !projects.some((x) => x.projectId === p.projectId));
  const allowed = (roles: RoleChoice[]) => roles.filter((r) => r.missing.length === 0);

  /** Il ruolo di base in un progetto: Developer se si può dare, altrimenti il primo che si può. */
  const defaultRoleOf = (roles: RoleChoice[]) =>
    (allowed(roles).find((r) => r.name === "Developer") ?? allowed(roles)[0])?.roleId ?? "";

  async function submit() {
    setError(null);
    setEmailError(null);
    const input = { email, instanceRoleId, projects };
    const result = await reauth(() => create.mutateAsync([input]), {
      action: t("admin.invite.reauthAction", { email: email.trim() }),
    }).catch(() => null);
    if (result === null) return setError(t("admin.refusal.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (!refusal) {
      const ok = result as { link: string; expiresAt: string };
      return onCreated({ email: email.trim().toLowerCase(), link: ok.link, expiresAt: ok.expiresAt });
    }
    if (
      refusal.error === "invalid" &&
      ["email", "email_taken", "invite_exists"].includes(refusal.reason)
    )
      return setEmailError(t(`admin.invite.errors.${refusal.reason}`));
    // Un ruolo oltre chi invita (lo stato è cambiato nel frattempo): si nomina il ruolo d'istanza.
    setError(refusalWords(refusal, { what: instanceRole?.name }));
  }

  return (
    <Dialog
      title={t("admin.invite.title")}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("admin.invite.cancel")}
          </button>
          <button
            type="button"
            className={`${primaryButton} disabled:opacity-40`}
            disabled={create.isPending || !email.trim() || projects.some((p) => !p.roleId)}
            onClick={() => void submit()}
          >
            {create.isPending ? t("admin.invite.creating") : t("admin.invite.create")}
          </button>
        </>
      }
    >
      <DialogField label={t("admin.invite.email")} htmlFor={emailId}>
        <input
          id={emailId}
          type="email"
          data-autofocus
          autoComplete="off"
          value={email}
          aria-invalid={emailError ? true : undefined}
          aria-describedby={emailError ? emailErrorId : undefined}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
        />
        {emailError && (
          <span id={emailErrorId}>
            <ErrorLine>{emailError}</ErrorLine>
          </span>
        )}
      </DialogField>
      <DialogField label={t("admin.invite.instanceRole")}>
        <RolePicker
          label={t("admin.invite.instanceRole")}
          roles={choices.instanceRoles}
          value={instanceRoleId}
          onChange={setInstanceRoleId}
        />
      </DialogField>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink">{t("admin.invite.projects")}</span>
        {choices.projects.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("admin.invite.noProjects")}</p>
        ) : (
          <>
            <span className="text-xs text-ink-muted">{t("admin.invite.projectsHint")}</span>
            {projects.length > 0 && (
              <ul className="flex flex-col">
                {projects.map((pick) => {
                  const project = choices.projects.find((p) => p.projectId === pick.projectId)!;
                  return (
                    <li
                      key={pick.projectId}
                      className="flex min-h-10 items-center gap-3 border-b border-rule last:border-b-0"
                    >
                      <span className="num w-10 shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
                        {project.code}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-ink-muted">
                        {project.name}
                      </span>
                      <span className="w-44 shrink-0">
                        <RolePicker
                          label={t("admin.invite.projectRole", { code: project.code })}
                          roles={project.roles}
                          value={pick.roleId}
                          onChange={(roleId) =>
                            setProjects((list) =>
                              list.map((x) => (x.projectId === pick.projectId ? { ...x, roleId } : x)),
                            )
                          }
                        />
                      </span>
                      <button
                        type="button"
                        className={rowButton}
                        aria-label={t("admin.invite.remove", { code: project.code })}
                        onClick={() =>
                          setProjects((list) => list.filter((x) => x.projectId !== pick.projectId))
                        }
                      >
                        {t("admin.invite.removeShort")}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {remaining.length > 0 && (
              <MenuButton
                menuLabel={t("admin.invite.chooseProject")}
                className={`${rowButton} -ml-2 gap-1 self-start`}
                label={
                  <>
                    {t("admin.invite.addProject")}
                    <Chevron />
                  </>
                }
              >
                {(close) => (
                  <MenuGroup label={t("admin.invite.chooseProject")}>
                    {remaining.map((p) => (
                      <button
                        key={p.projectId}
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        className={itemClass}
                        onClick={() => {
                          close();
                          setProjects((list) => [
                            ...list,
                            { projectId: p.projectId, roleId: defaultRoleOf(p.roles) },
                          ]);
                        }}
                      >
                        <span className="num w-10 shrink-0 text-xs font-semibold">{p.code}</span>
                        <span className="min-w-0 truncate">{p.name}</span>
                      </button>
                    ))}
                  </MenuGroup>
                )}
              </MenuButton>
            )}
          </>
        )}
      </div>
      {error && <ErrorLine>{error}</ErrorLine>}
    </Dialog>
  );
}

/**
 * La scelta di un ruolo, d'istanza o di progetto: il nome e il numero di
 * permessi; un ruolo che contiene permessi che chi agisce non ha è spento,
 * con «Includes permissions you don't have.» e quali nel `title`.
 */
export function RolePicker({
  label,
  roles,
  value,
  onChange,
}: {
  label: string;
  roles: RoleChoice[];
  value: string;
  onChange: (roleId: string) => void;
}) {
  const current = roles.find((r) => r.roleId === value);
  return (
    <MenuButton
      menuLabel={label}
      ariaLabel={`${label}: ${current?.name ?? ""}`}
      wrapperClassName="flex min-w-0"
      className={selectButtonClass}
      label={
        <>
          <span className="min-w-0 flex-1 truncate">{current?.name ?? "—"}</span>
          <Chevron />
        </>
      }
    >
      {(close) => (
        <RoleOptions
          roles={roles}
          value={value}
          onPick={(roleId) => {
            close();
            onChange(roleId);
          }}
        />
      )}
    </MenuButton>
  );
}

/** Le voci di un menu dei ruoli: spente col motivo quando contengono ciò che non si ha. */
export function RoleOptions({
  roles,
  value,
  onPick,
  footer,
}: {
  roles: RoleChoice[];
  value: string;
  onPick: (roleId: string) => void;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  const missingWords = useMissingWords();
  return (
    <>
      {roles.map((r) => {
        const blocked = r.missing.length > 0;
        return (
          <button
            key={r.roleId}
            type="button"
            role="menuitemradio"
            aria-checked={r.roleId === value}
            aria-disabled={blocked || undefined}
            tabIndex={-1}
            title={blocked ? missingWords(r.missing) : undefined}
            onClick={() => {
              if (!blocked) onPick(r.roleId);
            }}
            className={`${itemClass} ${blocked ? "cursor-default hover:bg-transparent" : ""}`}
          >
            <RadioDot checked={r.roleId === value} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={`flex items-baseline gap-2 ${blocked ? "text-ink-muted" : ""}`}>
                <span className="min-w-0 truncate">{r.name}</span>
                <span className="num ml-auto shrink-0 text-xs text-ink-faint">
                  {t("admin.person.instanceRole.permissions", { count: r.permissionCount })}
                </span>
              </span>
              {blocked && (
                <span className="text-xs text-ink-muted">
                  {t("admin.person.instanceRole.beyond")}
                </span>
              )}
            </span>
          </button>
        );
      })}
      {footer && <MenuNote>{footer}</MenuNote>}
    </>
  );
}
