import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAddProjectMember,
  useAdminPeople,
  type ProjectMembersView,
} from "../../data/queries";
import type { Project } from "../../data/types";
import { useReauth } from "../../layout/useReauth";
import { Dialog, inputClass } from "../../tasks-ui/Dialog";
import { RadioDot } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { RolePicker } from "../admin/InviteDialog";
import { AdminAvatar, useMissingWords, useRefusalWords, type UiRefusal } from "../admin/parts";
import { WriteError, refusalOf } from "../preferences/parts";
import { primaryButton, secondaryButton } from "../tasks/controls";

// «Add member» (shape admin-roles-members.md, «Add member»): la persona fra
// quelle attive non ancora membri (niente Claude, niente disattivati, niente
// full admin: lo dice `addable` del livello dati) e il ruolo, poi la
// riconferma. Chi entrando riceverebbe dal reparto permessi che chi aggiunge
// non ha è spento col motivo (`addableMissing`); un ruolo oltre chi aggiunge
// anche (`roleChoices`). Dalla pagina di una persona si arriva con lei già
// scelta (`?addMember=<id>`).

export function AddMemberDialog({
  project,
  view,
  preselect,
  onClose,
  onAdded,
}: {
  project: Project;
  view: ProjectMembersView;
  /** La persona già scelta (da «Add to a project» nella sua pagina). */
  preselect?: string;
  onClose: () => void;
  onAdded: (personId: string) => void;
}) {
  const { t } = useTranslation();
  const add = useAddProjectMember();
  const reauth = useReauth();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const missingWords = useMissingWords();
  const people = useAdminPeople({ statuses: ["active"] }).data ?? [];
  const code = project.code;
  const [q, setQ] = useState("");
  const [personId, setPersonId] = useState<string | null>(
    // Chi arriverebbe con permessi di reparto che chi guarda non ha non è già
    // scelto: il rifiuto si dice prima, sulla riga spenta (Minor 4 del Task 10).
    preselect &&
      view.addable.includes(preselect) &&
      (view.addableMissing[preselect] ?? []).length === 0
      ? preselect
      : null,
  );
  const [roleId, setRoleId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const findId = useId();

  const needle = q.trim().toLowerCase();
  const candidates = people
    .filter((p) => view.addable.includes(p.personId))
    .sort((a, b) => a.name.localeCompare(b.name));
  const rows = candidates.filter(
    (p) => !needle || `${p.name} ${p.email}`.toLowerCase().includes(needle),
  );
  const person = candidates.find((p) => p.personId === personId);
  const role = view.roleChoices.find((r) => r.roleId === roleId);

  async function onAdd() {
    if (!person || !role) return;
    setError(null);
    setAdding(true);
    const result = await reauth(() => add.mutateAsync([project.id, person.personId, role.roleId]), {
      action: t("settings.members.addDialog.action", { name: person.name, code }),
    }).catch(() => null);
    setAdding(false);
    if (result === null) return setError(t("settings.members.addDialog.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal) {
      if (refusal.error === "reauth_cancelled")
        return void toast.show(t("admin.refusal.reauthCancelled"));
      if (refusal.error === "escalation")
        return setError(
          t("settings.members.refusal.escalationMany", {
            missing: missingWords((refusal as { missing: string[] }).missing),
          }),
        );
      return setError(refusalWords(refusal, { name: person.name }));
    }
    toast.show(
      t("settings.members.addDialog.joined", { name: person.name, code, role: role.name }),
    );
    onAdded(person.personId);
  }

  return (
    <Dialog
      title={t("settings.members.add")}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("settings.members.addDialog.cancel")}
          </button>
          <button
            type="button"
            className={`${primaryButton} disabled:opacity-40`}
            disabled={!person || !role || adding}
            onClick={() => void onAdd()}
          >
            {t("settings.members.addDialog.add")}
          </button>
        </>
      }
    >
      {view.addable.length === 0 ? (
        <p className="text-md text-ink-muted">{t("settings.members.addDialog.noOne", { code })}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={findId} className="text-sm font-medium text-ink">
              {t("settings.members.addDialog.person")}
            </label>
            <input
              id={findId}
              data-autofocus
              type="search"
              value={q}
              aria-label={t("settings.members.addDialog.findLabel")}
              placeholder={t("settings.members.addDialog.find")}
              onChange={(e) => setQ(e.target.value)}
              className={inputClass}
            />
            {rows.length === 0 ? (
              <p className="px-1 py-2 text-sm text-ink-muted">
                {t("settings.members.addDialog.noMatch")}
              </p>
            ) : (
              <ul
                role="radiogroup"
                aria-label={t("settings.members.addDialog.candidates", { code })}
                className="flex max-h-56 flex-col overflow-y-auto rounded-md border border-rule p-1"
              >
                {rows.map((p) => {
                  const missing = view.addableMissing[p.personId] ?? [];
                  const blocked = missing.length > 0;
                  const on = p.personId === personId;
                  return (
                    <li key={p.personId}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-disabled={blocked || undefined}
                        onClick={() => {
                          if (!blocked) setPersonId(p.personId);
                        }}
                        className={`flex w-full min-w-0 items-start gap-2.5 rounded-md px-1.5 py-1.5 text-left transition-colors duration-[var(--duration-fast)] ease-out ${blocked ? "cursor-default" : on ? "bg-ink/10" : "hover:bg-ink/6"}`}
                      >
                        <span className="mt-1.5 shrink-0">
                          <RadioDot checked={on} />
                        </span>
                        <AdminAvatar initials={p.avatar} muted={blocked} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span
                            className={`truncate text-md ${blocked ? "text-ink-muted" : "text-ink"}`}
                          >
                            {p.name}
                          </span>
                          <span className="text-xs text-pretty text-ink-muted">
                            {blocked
                              ? t("settings.members.addDialog.cantAdd", {
                                  code,
                                  missing: missingWords(missing),
                                })
                              : p.email}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">
              {t("settings.members.addDialog.role")}
            </span>
            <RolePicker
              label={t("settings.members.panel.roleLabel", { code })}
              roles={view.roleChoices}
              value={roleId}
              onChange={setRoleId}
              placeholder={t("settings.members.addDialog.pickRole")}
            />
          </div>
          {error && <WriteError message={error} />}
        </div>
      )}
    </Dialog>
  );
}
