import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCreateAutomation, useProjects } from "../../data/queries";
import { Dialog, DialogField, inputClass } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { useAutomationPerms } from "./shared";

// «New automation» (shape automations.md §⌘K, «Creazione»): nome e progetto
// («General» solo col permesso d'istanza; i progetti dove posso gestirne).
// Nasce una bozza mai accesa, col codice assegnato alla creazione.
//
// TODO(Task 6): la partenza da un modello («New contract → tasks…», «Ask the
// client…») porta il flusso del modello, e «Create» apre il costruttore
// (`/automations/$code/edit`); finché non c'è, la bozza nasce vuota e si
// apre il suo dettaglio.

export type AutomationTemplate = "newContract" | "askClient";

export function CreateAutomationDialog({
  onClose,
  template,
  projectId: initialProject,
}: {
  onClose: () => void;
  template?: AutomationTemplate;
  projectId?: string | null;
}) {
  const { t } = useTranslation();
  const perms = useAutomationPerms();
  const projects = (useProjects().data ?? [])
    .filter((p) => perms.inProject(p.id))
    .sort((a, b) => a.code.localeCompare(b.code));
  const create = useCreateAutomation();
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState(template ? t(`automations.templates.${template}.title`) : "");
  const [project, setProject] = useState<string>(
    initialProject ?? (perms.instance ? "" : (projects[0]?.id ?? "")),
  );
  const nameId = useId();
  const projectId = useId();
  const canCreate = name.trim() !== "" && (project !== "" || perms.instance);

  const submit = () => {
    if (!canCreate) return;
    create.mutate(
      { name: name.trim(), projectId: project === "" ? null : project },
      {
        onSuccess: (a) => {
          onClose();
          void navigate({ to: "/automations/$code", params: { code: a.code } } as never);
        },
        onError: () => toast.error(t("automations.create.error")),
      },
    );
  };

  return (
    <Dialog
      title={t("automations.create.title")}
      width={480}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            className={`${primaryButton} disabled:opacity-40`}
            disabled={!canCreate || create.isPending}
            onClick={submit}
          >
            {t("automations.create.submit")}
          </button>
        </>
      }
    >
      <DialogField label={t("automations.create.name")} htmlFor={nameId}>
        <input
          id={nameId}
          data-autofocus
          className={inputClass}
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </DialogField>
      <DialogField label={t("automations.create.project")} htmlFor={projectId}>
        <select
          id={projectId}
          className={`${inputClass} h-8`}
          value={project}
          onChange={(e) => setProject(e.target.value)}
        >
          {perms.instance && <option value="">{t("automations.general")}</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} · {p.name}
            </option>
          ))}
        </select>
      </DialogField>
    </Dialog>
  );
}
