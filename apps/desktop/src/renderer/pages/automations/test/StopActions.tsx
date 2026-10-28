import { Link } from "@tanstack/react-router";
import { useId, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ReasonCode, SimulationEffectPreview, SimulationWaiting } from "../../../data/types";
import { inputClass } from "../../../tasks-ui/Dialog";
import { primaryButton, secondaryButton } from "../../tasks/controls";
import { reasonWords } from "../format";
import { usePreviewProps, useTest } from "./context";
import { EffectPreview, EmailPreview, FailurePreview } from "../previews/Previews";

// Le fermate della prova (shape automation-test §5, «Fermate»): il pannello
// dice cosa succederebbe ora e il bottone che sblocca la prova; accanto, in
// una riga, cosa succederebbe DAVVERO. Approvare nella prova sblocca solo la
// prova, a nome di chi prova ([A 8]): l'esecuzione vera aspetterà comunque
// chi è indicato nel passo (regola 1). Nessuna riga nella tabella cliente →
// progetto, nessuna email vera.

const DAY = 86_400_000;

/**
 * Esc in un campo della fermata resta al campo: non chiude il pannello né
 * fa uscire dalla prova (il pannello e la pagina rispettano `defaultPrevented`).
 */
const keepEsc = (e: KeyboardEvent) => {
  if (e.key === "Escape") e.preventDefault();
};

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
        ? t("automations.test.stop.realOwnerYou", { name: ctx.names.person(waiting.ownerId) })
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
  failure: { why: ReasonCode | null } | null;
}) {
  const { t } = useTranslation();
  const pp = usePreviewProps();
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
  if (failure) return <FailingApprovalStop waiting={waiting} preview={preview} failure={failure} />;
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
              onKeyDown={keepEsc}
              value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
            />
          </label>
          <label htmlFor={bodyId} className="flex flex-col gap-1 text-sm text-ink-muted">
            {t("automations.dataKeys.body")}
            <textarea
              id={bodyId}
              className={`${inputClass} min-h-40`}
              onKeyDown={keepEsc}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </label>
          <EmailPreview {...pp} p={email} edited={draft} />
        </div>
      ) : (
        preview && <EffectPreview {...pp} p={preview} />
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

/** Le motivazioni che si risolvono collegando una casella nella Posta. */
const MAILBOX_REASONS = new Set(["noMailbox", "mailboxGone", "mailboxExpired"]);

/**
 * Un'approvazione che, data, farebbe fallire il passo (es. il proprietario
 * non ha una casella): il motivo per primo, al condizionale, con cosa fare;
 * poi chi approverebbe e l'anteprima; al posto di Approve/Reject un solo
 * «See where it stops», che approva nella prova e la porta dove si ferma.
 */
function FailingApprovalStop({
  waiting,
  preview,
  failure,
}: {
  waiting: Extract<SimulationWaiting, { kind: "approval" }>;
  preview: SimulationEffectPreview | null;
  failure: { why: ReasonCode | null };
}) {
  const { t } = useTranslation();
  const pp = usePreviewProps();
  const ctx = useTest();
  const code = failure.why?.code ?? "";
  const action = MAILBOX_REASONS.has(code) ? (
    <Link
      to="/mail"
      className="self-start text-md text-ink underline underline-offset-4 hover:no-underline"
    >
      {t("automations.test.stop.connectMailbox")}
    </Link>
  ) : null;
  return (
    <div className="flex flex-col gap-4">
      <FailurePreview
        reason={reasonWords(failure.why, t, { would: true })}
        claude={false}
        action={action}
      />
      <RealApprover waiting={waiting} preview={preview} />
      {preview?.kind === "email" ? (
        <EmailPreview
          {...pp}
          p={preview}
          fromMissing={
            code === "mailboxExpired" ? t("automations.test.preview.mailboxExpiredFrom") : undefined
          }
        />
      ) : (
        preview && <EffectPreview {...pp} p={preview} />
      )}
      <div
        data-stop-actions
        className="flex flex-wrap items-center gap-2 border-t border-rule pt-3"
      >
        <button
          type="button"
          data-stop-primary
          className={secondaryButton}
          disabled={ctx.busy}
          onClick={async () => {
            // Approvato nella prova, il passo prova a partire e si ferma dove fallirebbe.
            await ctx.send({ kind: "approved", path: waiting.path, byId: ctx.me });
            await ctx.send({ kind: "next" });
          }}
        >
          {t("automations.test.stop.seeWhereItStops")}
        </button>
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
            onKeyDown={keepEsc}
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

/** Il cliente non è in tabella: un progetto per la prova, fra quelli del proprietario. La tabella non cambia. */
export function ProjectStop({
  waiting,
}: {
  waiting: Extract<SimulationWaiting, { kind: "project" }>;
}) {
  const { t } = useTranslation();
  const ctx = useTest();
  // I progetti che vedrebbe il proprietario, come nell'esecuzione vera (fra quelli che vedi).
  const projects = waiting.choices ?? [];
  const [projectId, setProjectId] = useState("");
  const id = useId();
  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-[68ch] text-md text-ink">
        {waiting.clientName
          ? t("automations.test.stop.project", { client: waiting.clientName })
          : t("automations.test.stop.projectNoClient")}
      </p>
      {projects.length === 0 ? (
        // Nessun progetto che il proprietario vedrebbe e che vedi anche tu: un menu vuoto non spiega niente.
        <p data-no-projects className="max-w-[68ch] border-t border-rule pt-3 text-md text-ink">
          {t("automations.test.stop.noProjects")}
        </p>
      ) : (
        <div data-stop-actions className="flex flex-wrap items-end gap-2 border-t border-rule pt-3">
          <label htmlFor={id} className="flex min-w-56 flex-col gap-1 text-sm text-ink-muted">
            {t("automations.test.stop.pickProject")}
            <select
              id={id}
              data-stop-primary
              className={`${inputClass} h-8`}
              onKeyDown={keepEsc}
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
      )}
    </div>
  );
}
