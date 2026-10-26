import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjects } from "../../../data/queries";
import type { SimulationEffectPreview, SimulationWaiting } from "../../../data/types";
import { inputClass } from "../../../tasks-ui/Dialog";
import { primaryButton, secondaryButton } from "../../tasks/controls";
import { useTest } from "./context";
import { EffectPreview, EmailPreview, FailurePreview } from "./Previews";

// Le fermate della prova (shape automation-test §5, «Fermate»): il pannello
// dice cosa succederebbe ora e il bottone che sblocca la prova; accanto, in
// una riga, cosa succederebbe DAVVERO. Approvare nella prova sblocca solo la
// prova, a nome di chi prova ([A 8]): l'esecuzione vera aspetterà comunque
// chi è indicato nel passo (regola 1). Nessuna riga nella tabella cliente →
// progetto, nessuna email vera.

const DAY = 86_400_000;

/** La riga «In a real run, this waits for …» di un'approvazione. */
export function RealApprover({
  waiting,
  preview,
}: {
  waiting: Extract<SimulationWaiting, { kind: "approval" }>;
  preview: SimulationEffectPreview | null;
}) {
  const { t } = useTranslation();
  const ctx = useTest();
  const who = waiting.who;
  let line: string;
  if ("owner" in who) {
    line =
      ctx.sim?.draft && waiting.ownerId === ctx.me
        ? t("automations.test.stop.realOwnerYou")
        : t("automations.test.stop.realOwner", { name: ctx.names.person(waiting.ownerId) });
  } else if ("personId" in who) {
    line = t("automations.test.stop.realPerson", { name: ctx.names.person(who.personId) });
  } else {
    const project = preview && "project" in preview && preview.project ? preview.project : null;
    const code = project?.code || ctx.names.project(ctx.automation.projectId)?.code || "";
    const name = waiting.realApproverIds[0];
    line = name
      ? t("automations.test.stop.realRole", {
          role: t(`automations.roles.${who.projectRole}`, { defaultValue: who.projectRole }),
          code,
          name: ctx.names.person(name),
        })
      : t("automations.test.stop.realRoleNobody", {
          role: t(`automations.roles.${who.projectRole}`, { defaultValue: who.projectRole }),
          code,
        });
  }
  return (
    <p data-real-approver className="text-md text-ink">
      {line}
    </p>
  );
}

/** L'approvazione nella prova: anteprima completa, la riga dell'approvatore vero, Approve/Reject. */
export function ApprovalStop({
  waiting,
  preview,
  failure,
}: {
  waiting: Extract<SimulationWaiting, { kind: "approval" }>;
  preview: SimulationEffectPreview | null;
  /** Approvato, il passo fallirebbe comunque (es. la casella scaduta): si vede già prima. */
  failure: { reason: string | null } | null;
}) {
  const { t } = useTranslation();
  const ctx = useTest();
  const email = preview?.kind === "email" ? preview : null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => ({
    subject: email?.subject ?? "",
    body: email?.body ?? "",
  }));
  const changed =
    email &&
    Object.fromEntries(
      Object.entries(draft).filter(([k, v]) => v !== email[k as "subject" | "body"]),
    );
  const subjectId = useId();
  const bodyId = useId();
  return (
    <div className="flex flex-col gap-4">
      <RealApprover waiting={waiting} preview={preview} />
      {editing && email ? (
        <div className="flex flex-col gap-3">
          <label htmlFor={subjectId} className="flex flex-col gap-1 text-sm text-ink-muted">
            {t("automations.test.preview.subject")}
            <input
              id={subjectId}
              className={inputClass}
              value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
            />
          </label>
          <label htmlFor={bodyId} className="flex flex-col gap-1 text-sm text-ink-muted">
            {t("automations.test.stop.replyText")}
            <textarea
              id={bodyId}
              className={`${inputClass} min-h-40`}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </label>
          <EmailPreview p={email} edited={draft} />
        </div>
      ) : (
        <>
          {preview && <EffectPreview p={preview} />}
          {failure && <FailurePreview reason={failure.reason} claude={false} />}
        </>
      )}
      <div
        data-stop-actions
        className="flex flex-wrap items-center gap-2 border-t border-rule pt-3"
      >
        <button
          type="button"
          data-stop-primary
          className={primaryButton}
          disabled={ctx.busy}
          onClick={() =>
            void ctx.send({
              kind: "approved",
              path: waiting.path,
              byId: ctx.me,
              ...(editing && changed && Object.keys(changed).length > 0 ? { edited: changed } : {}),
            })
          }
        >
          {editing ? t("automations.test.stop.approveEdited") : t("automations.test.stop.approve")}
        </button>
        <button
          type="button"
          className={secondaryButton}
          disabled={ctx.busy}
          onClick={() => void ctx.send({ kind: "rejected", path: waiting.path, byId: ctx.me })}
        >
          {t("automations.test.stop.reject")}
        </button>
        {email && !editing && (
          <button type="button" className={secondaryButton} onClick={() => setEditing(true)}>
            {t("automations.test.stop.edit")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Un'attesa: «Skip ahead», la risposta del cliente scritta nella prova, la task chiusa nella prova. */
export function EventStop({ waiting }: { waiting: Extract<SimulationWaiting, { kind: "event" }> }) {
  const { t } = useTranslation();
  const ctx = useTest();
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const textId = useId();
  const w = waiting.wait;
  const days =
    "days" in w
      ? w.days
      : Math.max(
          1,
          Math.round((Date.parse(waiting.until) - Date.parse(ctx.sim?.now ?? waiting.until)) / DAY),
        );
  const skip = () => void ctx.send({ kind: "time", now: waiting.until });
  if ("replyTo" in w && writing) {
    return (
      <form
        data-reply-composer
        className="flex flex-col gap-3 border-t border-rule pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          void ctx.send({ kind: "event", payload: { kind: "reply", to: w.replyTo, text } });
        }}
      >
        <p className="text-sm text-ink-muted">
          {t("automations.test.stop.replyFrom")}{" "}
          <span className="text-ink">{waiting.email?.to ?? ""}</span>
        </p>
        <label htmlFor={textId} className="flex flex-col gap-1 text-sm text-ink-muted">
          {t("automations.test.stop.replyText")}
          <textarea
            id={textId}
            autoFocus
            className={`${inputClass} min-h-32`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="submit" data-stop-primary className={primaryButton} disabled={ctx.busy}>
            {t("automations.test.stop.useReply")}
          </button>
          <button type="button" className={secondaryButton} onClick={() => setWriting(false)}>
            {t("automations.actions.cancel")}
          </button>
        </div>
      </form>
    );
  }
  return (
    <div data-stop-actions className="flex flex-wrap items-center gap-2 border-t border-rule pt-3">
      {"replyTo" in w && (
        <>
          <button
            type="button"
            data-stop-primary
            className={primaryButton}
            onClick={() => setWriting(true)}
          >
            {t("automations.test.stop.writeReply")}
          </button>
          <button type="button" className={secondaryButton} disabled={ctx.busy} onClick={skip}>
            {t("automations.test.stop.skipNoReply", { count: days })}
          </button>
        </>
      )}
      {"taskClosed" in w && (
        <>
          <button
            type="button"
            data-stop-primary
            className={primaryButton}
            disabled={ctx.busy}
            onClick={() =>
              void ctx.send({
                kind: "event",
                payload: { kind: "task_closed", taskStepId: w.taskClosed },
              })
            }
          >
            {t("automations.test.stop.closeIt")}
          </button>
          <button type="button" className={secondaryButton} disabled={ctx.busy} onClick={skip}>
            {t("automations.test.stop.skipNotClosed", { count: days })}
          </button>
        </>
      )}
      {"days" in w && (
        <button
          type="button"
          data-stop-primary
          className={primaryButton}
          disabled={ctx.busy}
          onClick={skip}
        >
          {t("automations.test.stop.skip", { count: days })}
        </button>
      )}
    </div>
  );
}

/** Il cliente non è in tabella: un progetto per la prova. La tabella non cambia. */
export function ProjectStop({
  waiting,
}: {
  waiting: Extract<SimulationWaiting, { kind: "project" }>;
}) {
  const { t } = useTranslation();
  const ctx = useTest();
  const projects = [...(useProjects().data ?? [])].sort((a, b) => a.code.localeCompare(b.code));
  const [projectId, setProjectId] = useState("");
  const id = useId();
  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-[68ch] text-md text-ink">
        {waiting.clientName
          ? t("automations.test.stop.project", { client: waiting.clientName })
          : t("automations.test.stop.projectNoClient")}
      </p>
      <div data-stop-actions className="flex flex-wrap items-end gap-2 border-t border-rule pt-3">
        <label htmlFor={id} className="flex min-w-56 flex-col gap-1 text-sm text-ink-muted">
          {t("automations.test.stop.pickProject")}
          <select
            id={id}
            data-stop-primary
            className={`${inputClass} h-8`}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">{t("automations.test.stop.pickProjectNone")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`${primaryButton} disabled:opacity-40`}
          disabled={!projectId || ctx.busy}
          onClick={() => void ctx.send({ kind: "project_chosen", projectId })}
        >
          {t("automations.test.stop.useProject")}
        </button>
      </div>
    </div>
  );
}
