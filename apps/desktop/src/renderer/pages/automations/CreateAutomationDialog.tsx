import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCreateAutomation, useProjects } from "../../data/queries";
import { Dialog, DialogField, inputClass } from "../../tasks-ui/Dialog";
import { RadioDot } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { useAutomationPerms } from "./shared";

// «New automation» (shape automation-builder.md §«Modelli e New automation»,
// [A 20]): nome, dove lavora (in un progetto dove posso gestirne, o fra i
// progetti — solo col permesso d'istanza) e da cosa parte: vuota o uno dei
// due modelli. Nasce una bozza mai accesa col codice assegnato alla
// creazione, e si apre il costruttore. Dal modello le scelte personali
// (sorgente, approvatori, reparti) arrivano vuote: sono già problemi da
// completare, mai riempite con persone del seme.

export type AutomationTemplate = "newContract" | "askClient";

/** Quanti passi ha ogni modello (il test lo confronta coi flussi veri). */
export const TEMPLATE_STEPS: Record<AutomationTemplate, number> = {
  newContract: 11,
  askClient: 14,
};

export function CreateAutomationDialog({
  onClose,
  template: initialTemplate,
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
  const [template, setTemplate] = useState<AutomationTemplate | null>(initialTemplate ?? null);
  const [name, setName] = useState(
    initialTemplate ? t(`automations.templates.${initialTemplate}.title`) : "",
  );
  const [touched, setTouched] = useState(false);
  const [project, setProject] = useState<string>(
    initialProject ?? (perms.instance ? "" : (projects[0]?.id ?? "")),
  );
  const nameId = useId();
  const projectId = useId();
  const startId = useId();
  const canCreate = name.trim() !== "" && (project !== "" || perms.instance);

  const pick = (next: AutomationTemplate | null) => {
    setTemplate(next);
    // Il nome segue il modello finché chi crea non l'ha scritto lui.
    if (!touched) setName(next ? t(`automations.templates.${next}.title`) : "");
  };

  const submit = () => {
    if (!canCreate) return;
    create.mutate(
      {
        name: name.trim(),
        projectId: project === "" ? null : project,
        template: template ?? undefined,
      },
      {
        onSuccess: (a) => {
          onClose();
          void navigate({ to: "/automations/$code/edit", params: { code: a.code } } as never);
        },
        onError: () => toast.error(t("automations.create.error")),
      },
    );
  };

  const row = (value: AutomationTemplate | null) => {
    const on = template === value;
    return (
      <button
        key={value ?? "blank"}
        type="button"
        role="radio"
        aria-checked={on}
        onClick={() => pick(value)}
        className={`flex items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors duration-[var(--duration-fast)] ease-out ${on ? "border-rule-strong bg-ink/6" : "border-rule hover:bg-ink/4"}`}
      >
        <span className="pt-0.5">
          <RadioDot checked={on} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-md font-medium text-ink">
            {value ? t(`automations.templates.${value}.title`) : t("automations.create.blank")}
          </span>
          <span className="text-sm text-ink-muted">
            {value ? t(`automations.templates.${value}.body`) : t("automations.create.blankBody")}
          </span>
        </span>
        {value && (
          <span className="num shrink-0 pt-0.5 text-xs text-ink-faint">
            {t("automations.create.steps", { count: TEMPLATE_STEPS[value] })}
          </span>
        )}
      </button>
    );
  };

  return (
    <Dialog
      title={t("automations.create.title")}
      width={640}
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
          onChange={(e) => {
            setTouched(true);
            setName(e.target.value);
          }}
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
          {perms.instance && <option value="">{t("automations.create.general")}</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} · {p.name}
            </option>
          ))}
        </select>
      </DialogField>
      <div className="flex flex-col gap-1.5">
        <span id={startId} className="text-sm font-medium text-ink">
          {t("automations.create.startFrom")}
        </span>
        <div role="radiogroup" aria-labelledby={startId} className="flex flex-col gap-1.5">
          {row(null)}
          {row("newContract")}
          {row("askClient")}
        </div>
        {template && (
          <p className="text-xs text-ink-muted">{t("automations.create.templateNote")}</p>
        )}
      </div>
    </Dialog>
  );
}
