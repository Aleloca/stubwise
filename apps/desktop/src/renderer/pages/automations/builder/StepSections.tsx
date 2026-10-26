import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { availableFields } from "../../../domain/automations/fields";
import { usePeople, useProjects } from "../../../data/queries";
import type { Approval, ProjectTarget, Step } from "../../../data/types";
import { useAutomationPerms } from "../shared";
import { useBuilder } from "./context";
import { Field, Note, RadioRow, Section, Segmented, selectClass } from "./controls";
import { tokenLabel } from "./DataText";
import { ROLES, useFieldProblem, type FormProps } from "./stepFields";

// Le due sezioni comuni ai passi che producono un effetto: «Where» ([A 19])
// e «Before it runs» ([A 2]).

export function WhereSection({ step, path, set, problems }: FormProps) {
  const { t } = useTranslation();
  const b = useBuilder();
  const perms = useAutomationPerms();
  const projects = useProjects().data ?? [];
  const target = (step as { project: ProjectTarget }).project;
  const own = b.automation.projectId;
  const ownCode = b.names.project(own)?.code;
  const kind = step.kind as "createTask" | "createMilestone" | "createRequest";
  const client = useFieldProblem(problems, "client");
  const fixed = useFieldProblem(problems, "project");
  const where = useFieldProblem(problems, "where");
  const keys = availableFields(b.flow, path, b.sources).filter(
    (f) => f.type === "text" || f.type === "email",
  );
  const allowed = projects
    .filter((p) => perms.canCreate(kind, p.id))
    .sort((a, c) => a.code.localeCompare(c.code));
  const options = [
    ...(own
      ? [
          {
            value: "own" as const,
            label: t("automations.builder.where.own", { code: ownCode ?? "" }),
          },
        ]
      : []),
    { value: "from_client" as const, label: t("automations.builder.where.client") },
    { value: "fixed" as const, label: t("automations.builder.where.fixed") },
  ];
  return (
    <Section title={t("automations.builder.where.title")}>
      <Segmented
        label={t("automations.builder.where.title")}
        value={target.mode}
        options={options}
        onChange={(m) =>
          set({
            project:
              m === "own"
                ? { mode: "own" }
                : m === "fixed"
                  ? { mode: "fixed", projectId: "" }
                  : { mode: "from_client", clientRef: "" },
          } as Partial<Step>)
        }
      />
      {where.error}
      {target.mode === "from_client" && (
        <>
          <Field label={t("automations.builder.where.clientData")} required>
            <select
              aria-label={t("automations.builder.where.clientData")}
              aria-describedby={client.describedBy}
              aria-invalid={client.invalid || undefined}
              className={selectClass}
              value={target.clientRef}
              onChange={(e) =>
                set({
                  project: { mode: "from_client", clientRef: e.target.value },
                } as Partial<Step>)
              }
            >
              <option value="" disabled>
                {t("automations.builder.where.chooseClientData")}
              </option>
              {keys.map((f) => (
                <option key={f.key} value={f.key}>
                  {tokenLabel(b.flow, f.key, b.labels)}
                </option>
              ))}
            </select>
            {client.error}
          </Field>
          <Note>
            {t("automations.builder.where.clientNote")}{" "}
            <Link to="/automations/sources" className="text-ink underline underline-offset-4">
              {t("automations.builder.where.clientTable")}
            </Link>
          </Note>
        </>
      )}
      {target.mode === "fixed" && (
        <Field label={t("automations.builder.where.project")} required>
          <select
            aria-label={t("automations.builder.where.project")}
            aria-describedby={fixed.describedBy}
            aria-invalid={fixed.invalid || undefined}
            className={selectClass}
            value={target.projectId}
            onChange={(e) =>
              set({ project: { mode: "fixed", projectId: e.target.value } } as Partial<Step>)
            }
          >
            <option value="" disabled>
              {t("automations.builder.where.chooseProject")}
            </option>
            {target.projectId && !allowed.some((p) => p.id === target.projectId) && (
              <option value={target.projectId}>
                {b.names.project(target.projectId)?.code ?? t("automations.steps.inHiddenProject")}
              </option>
            )}
            {allowed.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
          {fixed.error}
        </Field>
      )}
    </Section>
  );
}

export function ApprovalSection({ step, set, problems }: Omit<FormProps, "path">) {
  const { t } = useTranslation();
  const b = useBuilder();
  const people = usePeople().data ?? [];
  const approval = (step as { approval: Approval }).approval;
  const p = useFieldProblem(problems, "approver");
  const ask = approval.mode === "ask" ? approval.who : null;
  const whoMode = !ask ? "owner" : "owner" in ask ? "owner" : "personId" in ask ? "person" : "role";
  const fromClient = "project" in step && step.project.mode === "from_client";
  const whoWords = !ask
    ? ""
    : "owner" in ask
      ? t("automations.builder.asks.theOwner")
      : "personId" in ask
        ? ask.personId
          ? b.names.person(ask.personId)
          : "…"
        : t(`automations.roles.${ask.projectRole}`, { defaultValue: ask.projectRole });
  return (
    <Section title={t("automations.builder.approval.title")}>
      <div
        role="radiogroup"
        aria-label={t("automations.builder.approval.title")}
        className="flex flex-col gap-2"
      >
        <RadioRow
          checked={approval.mode === "auto"}
          label={t("automations.builder.approval.auto")}
          body={t("automations.builder.approval.autoBody")}
          onSelect={() => set({ approval: { mode: "auto" } } as Partial<Step>)}
          disabled={b.readOnly}
        />
        <RadioRow
          checked={approval.mode === "ask"}
          label={t("automations.builder.approval.ask")}
          body={t("automations.builder.approval.askBody", {
            who: whoWords || t("automations.builder.asks.someone"),
          })}
          onSelect={() =>
            approval.mode !== "ask" &&
            set({ approval: { mode: "ask", who: { owner: true } } } as Partial<Step>)
          }
          disabled={b.readOnly}
        >
          <Field label={t("automations.builder.approval.who")}>
            <Segmented
              label={t("automations.builder.approval.who")}
              value={whoMode}
              options={[
                { value: "person", label: t("automations.builder.approval.person") },
                { value: "role", label: t("automations.builder.approval.role") },
                { value: "owner", label: t("automations.builder.approval.owner") },
              ]}
              onChange={(m) =>
                set({
                  approval: {
                    mode: "ask",
                    who:
                      m === "owner"
                        ? { owner: true }
                        : m === "person"
                          ? { personId: "" }
                          : { projectRole: "project_lead" },
                  },
                } as Partial<Step>)
              }
              disabled={b.readOnly}
            />
            {whoMode === "person" && (
              <select
                aria-label={t("automations.builder.approval.person")}
                aria-describedby={p.describedBy}
                aria-invalid={p.invalid || undefined}
                className={selectClass}
                value={ask && "personId" in ask ? ask.personId : ""}
                onChange={(e) =>
                  set({
                    approval: { mode: "ask", who: { personId: e.target.value } },
                  } as Partial<Step>)
                }
              >
                <option value="" disabled>
                  {t("automations.builder.panel.choosePerson")}
                </option>
                {people.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
            {whoMode === "role" && (
              <select
                aria-label={t("automations.builder.approval.role")}
                className={selectClass}
                value={ask && "projectRole" in ask ? ask.projectRole : "project_lead"}
                onChange={(e) =>
                  set({
                    approval: { mode: "ask", who: { projectRole: e.target.value } },
                  } as Partial<Step>)
                }
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(`automations.roles.${r}`)}
                  </option>
                ))}
              </select>
            )}
            {p.error}
            {fromClient && <Note>{t("automations.builder.approval.clientCheck")}</Note>}
          </Field>
        </RadioRow>
      </div>
    </Section>
  );
}
