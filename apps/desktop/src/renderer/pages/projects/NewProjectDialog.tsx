import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCreateProject, useProjects } from "../../data/queries";
import type { ProjectTemplate } from "../../data/types";
import { proposeProjectCode, validateProjectCode } from "../../domain/projectCode";
import { TEMPLATE_STATUSES } from "../../domain/templates";
import { Dialog, DialogField, inputClass } from "../../tasks-ui/Dialog";
import { RadioDot } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton, secondaryButton } from "../tasks/controls";

const TEMPLATES: ProjectTemplate[] = ["software", "marketing", "client", "empty"];

const choiceClass =
  "flex min-w-0 cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors duration-[var(--duration-fast)] ease-out has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus";

/**
 * «New project» (`projects.create`): nome, codice, tipo (interno o per un
 * cliente), cliente, modello. Il codice si propone dalle iniziali mentre si
 * scrive il nome (2–4 maiuscole, non già usato) e smette di seguirlo appena
 * lo si tocca; un codice già usato si dice in linea («AUD is already used»).
 * Il modello porta gli stati e i moduli iniziali: sotto ogni modello, i suoi
 * stati. Creato il progetto si atterra sulla sua Overview.
 */
export function NewProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (code: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const projects = useProjects().data;
  const create = useCreateProject();
  const nameId = useId();
  const codeId = useId();
  const clientId = useId();
  const codeHintId = useId();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [kind, setKind] = useState<"internal" | "client">("internal");
  const [clientName, setClientName] = useState("");
  const [template, setTemplate] = useState<ProjectTemplate>("empty");
  const [tried, setTried] = useState(false);
  // I codici dei progetti che chi guarda non vede: li dice solo il «server».
  const [takenElsewhere, setTakenElsewhere] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);

  const taken = useMemo(
    () => new Set([...(projects ?? []).map((p) => p.code), ...takenElsewhere]),
    [projects, takenElsewhere],
  );
  const shownCode = codeTouched ? code : (proposeProjectCode(name, taken) ?? "");
  const codeProblem = validateProjectCode(shownCode, taken);
  const nameMissing = !name.trim();
  const clientMissing = kind === "client" && !clientName.trim();
  const showCodeProblem = codeProblem && (tried || (codeTouched && codeProblem !== "required"));

  const submit = () => {
    setTried(true);
    if (nameMissing || codeProblem || clientMissing) return;
    setFailed(false);
    create.mutate(
      {
        code: shownCode,
        name: name.trim(),
        template,
        clientName: kind === "client" ? clientName.trim() : undefined,
      },
      {
        onSuccess: (project) => {
          toast.show(t("projects.newDialog.created", { code: project.code, name: project.name }));
          onCreated(project.code);
        },
        onError: (error) => {
          if (error.message.includes("code_taken")) {
            setTakenElsewhere((list) => [...list, shownCode]);
            // Il codice era proposto: se ne propone un altro; scritto a mano: si dice che è preso.
            if (!codeTouched) return;
          } else {
            setFailed(true);
          }
        },
      },
    );
  };

  return (
    <Dialog
      title={t("projects.newDialog.title")}
      description={t("projects.newDialog.description")}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("taskDetail.cancel")}
          </button>
          <button
            type="submit"
            form="new-project"
            className={primaryButton}
            disabled={create.isPending}
          >
            {t("projects.newDialog.submit")}
          </button>
        </>
      }
    >
      <form
        id="new-project"
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid grid-cols-[minmax(0,1fr)_112px] gap-3">
          <DialogField label={t("projects.newDialog.name")} htmlFor={nameId}>
            <input
              id={nameId}
              data-autofocus
              value={name}
              maxLength={80}
              aria-invalid={tried && nameMissing}
              placeholder={t("projects.newDialog.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
              className={`${inputClass} ${tried && nameMissing ? "border-critical" : ""}`}
            />
            {tried && nameMissing && (
              <span className="text-xs text-critical">{t("projects.newDialog.nameMissing")}</span>
            )}
          </DialogField>
          <DialogField label={t("projects.newDialog.code")} htmlFor={codeId}>
            <input
              id={codeId}
              value={shownCode}
              maxLength={4}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!showCodeProblem}
              aria-describedby={codeHintId}
              onChange={(e) => {
                setCodeTouched(true);
                setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""));
              }}
              className={`${inputClass} num font-semibold tracking-[0.04em] ${showCodeProblem ? "border-critical" : ""}`}
            />
          </DialogField>
        </div>
        <p
          id={codeHintId}
          className={`-mt-2 text-xs ${showCodeProblem ? "text-critical" : "text-ink-muted"}`}
        >
          {showCodeProblem
            ? t(`projects.newDialog.codeProblem.${codeProblem}`, { code: shownCode })
            : codeTouched
              ? t("projects.newDialog.codeHint")
              : t("projects.newDialog.codeProposed")}
        </p>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="pb-1.5 text-sm font-medium text-ink">
            {t("projects.newDialog.kind")}
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {(["internal", "client"] as const).map((k) => (
              <label
                key={k}
                className={`${choiceClass} ${kind === k ? "border-ink/60 bg-ink/4" : "border-rule-strong hover:border-ink/40"}`}
              >
                <input
                  type="radio"
                  name="project-kind"
                  value={k}
                  checked={kind === k}
                  onChange={() => setKind(k)}
                  className="sr-only"
                />
                <span className="mt-0.5">
                  <RadioDot checked={kind === k} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium text-ink">
                    {t(`projects.newDialog.kinds.${k}`)}
                  </span>
                  <span className="text-xs text-ink-muted">
                    {t(`projects.newDialog.kindHints.${k}`)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {kind === "client" && (
          <DialogField label={t("projects.newDialog.client")} htmlFor={clientId}>
            <input
              id={clientId}
              value={clientName}
              aria-invalid={tried && clientMissing}
              placeholder={t("projects.newDialog.clientPlaceholder")}
              onChange={(e) => setClientName(e.target.value)}
              className={`${inputClass} ${tried && clientMissing ? "border-critical" : ""}`}
            />
            {tried && clientMissing && (
              <span className="text-xs text-critical">{t("projects.newDialog.clientMissing")}</span>
            )}
          </DialogField>
        )}

        <fieldset className="flex flex-col">
          <legend className="pb-1.5 text-sm font-medium text-ink">
            {t("projects.newDialog.template")}
          </legend>
          <div className="flex flex-col gap-2">
            {TEMPLATES.map((key) => (
              <label
                key={key}
                className={`${choiceClass} ${template === key ? "border-ink/60 bg-ink/4" : "border-rule-strong hover:border-ink/40"}`}
              >
                <input
                  type="radio"
                  name="project-template"
                  value={key}
                  checked={template === key}
                  onChange={() => setTemplate(key)}
                  className="sr-only"
                />
                <span className="mt-0.5">
                  <RadioDot checked={template === key} />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium text-ink">
                    {t(`projects.templates.${key}`)}
                  </span>
                  <span className="text-xs text-ink-muted">
                    {TEMPLATE_STATUSES[key].map((s) => s.name).join(" · ")}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <p className="pt-1.5 text-xs text-ink-muted">{t("projects.newDialog.templateHint")}</p>
        </fieldset>

        {failed && (
          <p role="alert" className="rounded-md bg-critical/10 px-3 py-2 text-sm text-ink">
            {t("projects.newDialog.failed")}
          </p>
        )}
      </form>
    </Dialog>
  );
}
