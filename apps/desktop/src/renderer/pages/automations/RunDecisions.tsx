import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDecideAutomationNow, usePeople, useProjects } from "../../data/queries";
import type { SimulationEffectPreview } from "../../data/types";
import { inputClass } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { deferAnswer } from "../home/pendingAnswers";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { roleWords, type Names } from "./format";
import { EffectPreview, type PreviewWords } from "./previews/Previews";
import { useAutomationPerms } from "./shared";

// Le decisioni su un'esecuzione ferma — approvare un passo (anche con le
// correzioni, per un'email) e scegliere il progetto —, condivise dal
// riquadro «Now» e da «Da decidere» (shape automations.md §6). Ogni
// risposta segue la finestra dell'«Undo» come le altre risposte di
// «Decide» (`deferAnswer`): parte allo scadere, con la sessione di chi ha
// deciso anche se nel frattempo si cambia persona; l'effetto parte solo
// dopo. L'anteprima è quella condivisa con la prova (`previews/`), e torna
// alle righe etichetta · valore solo per i passi che non ne hanno una.

export const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Le chiavi dell'anteprima che si correggono prima di approvare, per tipo di passo. */
export const EDITABLE: Record<string, string[]> = {
  sendEmail: ["to", "subject", "body"],
};

const NO_STEPS = () => undefined;
const NO_LABELS = new Map();

/** Le righe etichetta · valore di un'anteprima senza forma condivisa (avvisi, avvii). */
export function PreviewBlock({
  preview,
  names,
  from,
  projectId = null,
}: {
  preview: Record<string, unknown>;
  names: Names;
  from: string | null;
  /** Il progetto in cui si cerca un ruolo («Project Lead di AUD»). */
  projectId?: string | null;
}) {
  const { t } = useTranslation();
  const rows: [string, string][] = [];
  if (from) rows.push([t("automations.preview.from"), from]);
  for (const [k, v] of Object.entries(preview)) {
    if (k === "body" || k === "descrizione") continue;
    if (k === "progetto") {
      const p = names.project(str(v));
      rows.push([
        t("automations.dataKeys.progetto"),
        p ? `${p.code} · ${p.name}` : t("automations.log.hiddenProject"),
      ]);
    } else if (k === "persona")
      rows.push([t("automations.dataKeys.persona"), names.person(str(v))]);
    else if (k === "ruolo")
      rows.push([t("automations.dataKeys.persona"), roleWords(str(v), projectId, names, t)]);
    else if (Array.isArray(v))
      rows.push([t(`automations.dataKeys.${k}`, { defaultValue: k }), v.join(", ")]);
    else rows.push([t(`automations.dataKeys.${k}`, { defaultValue: k }), String(v ?? "")]);
  }
  const body = str(preview.body) || str(preview.descrizione);
  if (rows.length === 0 && !body) return null;
  return (
    <div
      data-preview
      className="flex flex-col gap-2 rounded-md border border-rule bg-surface px-3 py-2.5"
    >
      <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-muted">{k}</dt>
            <dd className="text-ink [overflow-wrap:anywhere]">{v}</dd>
          </div>
        ))}
      </dl>
      {body && <p className="text-sm whitespace-pre-line text-ink">{body}</p>}
    </div>
  );
}

/** Il codice di un errore di una decisione (`invalid: <codice>`, `forbidden`, `not_found`). */
function decisionErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return message.startsWith("invalid: ") ? message.slice("invalid: ".length) : message;
}

/**
 * Manda una decisione allo scadere della finestra dell'«Undo» (5 s): la
 * voce si chiude subito, il messaggio offre «Undo». Se nel frattempo un
 * altro ha deciso, lo dice con il suo nome.
 */
function useDeferredDecision(runId: string, code: string) {
  const { t } = useTranslation();
  const toast = useToast();
  const decideNow = useDecideAutomationNow();
  const people = usePeople().data;

  const raced = async () => {
    const fresh = await decideNow.read(runId).catch(() => null);
    const byId = [...(fresh?.log ?? [])].reverse().find((e) => e.byId)?.byId;
    const name = people?.find((p) => p.id === byId)?.name;
    toast.show(
      name
        ? t("automations.decide.alreadyDecided", { name })
        : t("automations.decide.alreadyDecidedSomeone"),
    );
  };

  return (doneKey: string, send: (now: typeof decideNow) => Promise<unknown>) => {
    const cancel = deferAnswer(
      runId,
      () => send(decideNow),
      (error) => {
        switch (decisionErrorCode(error)) {
          // Un altro ha deciso (il passo è cambiato) o non decido più io.
          case "not_waiting":
          case "forbidden":
            return void raced();
          case "suspended":
            return toast.error(t("automations.decide.suspended", { code }));
          default:
            return toast.error(t("automations.toast.decisionError", { code }));
        }
      },
    );
    toast.show(t(doneKey, { code }), {
      action: { label: t("home.decide.undo"), run: cancel },
    });
  };
}

/**
 * L'anteprima del passo da approvare e, se chi guarda decide, Reject ·
 * Edit (solo email) · Approve. «Edit» apre sul posto A, Oggetto e Corpo
 * (gli allegati restano in sola lettura) con Cancel · Approve with changes.
 */
export function ApprovalBox({
  runId,
  cursor,
  code,
  stepKind,
  preview,
  effect,
  names,
  projectId,
  from,
  canDecide,
  compact = false,
  onDone,
}: {
  runId: string;
  /**
   * Il passo che aspetta, letto quando si clicca: la decisione vale solo per
   * lui (R-J8). Chi monta la casella la chiave anche su questo, così una
   * bozza corretta non sopravvive a un cambio di passo.
   */
  cursor: string;
  code: string;
  stepKind: string;
  preview: Record<string, unknown>;
  effect: SimulationEffectPreview | null;
  names: Names;
  /** Il progetto in cui si cerca un ruolo (anteprime senza forma condivisa). */
  projectId: string | null;
  /** «La casella di …» per un'anteprima senza forma condivisa. */
  from: string | null;
  canDecide: boolean;
  /** In «Da decidere»: il corpo dell'email chiuso alle prime righe, con «Show all». */
  compact?: boolean;
  /** Dopo la decisione (il fuoco va dove serve). */
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const decide = useDeferredDecision(runId, code);
  const editable = EDITABLE[stepKind] ?? [];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(editable.map((k) => [k, str(preview[k])])),
  );
  const changed = Object.fromEntries(
    Object.entries(draft).filter(([k, v]) => v !== str(preview[k])),
  );
  const words: PreviewWords = { names, numberOf: NO_STEPS, labels: NO_LABELS };
  const approve = (edited?: Record<string, string>) => {
    decide(edited ? "automations.toast.approvedChanges" : "automations.toast.approved", (now) =>
      now.approve(runId, cursor, edited),
    );
    setEditing(false);
    onDone?.();
  };
  const attachments = effect?.kind === "email" ? effect.attachments : [];

  const shown = effect ? (
    <div className="rounded-md border border-rule bg-surface px-3 py-3">
      <EffectPreview p={effect} words={words} clampBody={compact} />
    </div>
  ) : (
    <PreviewBlock preview={preview} names={names} projectId={projectId} from={from} />
  );

  if (editing) {
    return (
      <div data-approval-edit className="flex flex-col gap-2">
        {editable.map((k) => (
          <label key={k} className="flex flex-col gap-1 text-sm text-ink-muted">
            {t(`automations.dataKeys.${k}`)}
            {k === "body" ? (
              <textarea
                className={`${inputClass} min-h-32 resize-y`}
                value={draft[k]}
                onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
              />
            ) : (
              <input
                className={inputClass}
                value={draft[k]}
                onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
              />
            )}
          </label>
        ))}
        {attachments.length > 0 && (
          <p className="text-sm text-ink-muted">
            {t("automations.decide.attachmentsReadOnly", { names: attachments.join(", ") })}
          </p>
        )}
        <div className="flex items-center gap-2">
          <button type="button" className={secondaryButton} onClick={() => setEditing(false)}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            className={primaryButton}
            onClick={() => approve(Object.keys(changed).length ? changed : undefined)}
          >
            {t("automations.actions.approveChanges")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      {shown}
      {canDecide && (
        <div className="flex flex-wrap items-start gap-2">
          <div className="flex flex-col items-start gap-0.5">
            <button
              type="button"
              className={secondaryButton}
              onClick={() => {
                decide("automations.toast.rejected", (now) => now.reject(runId, cursor));
                onDone?.();
              }}
            >
              {t("automations.actions.reject")}
            </button>
            <span className="text-xs text-ink-muted">{t("automations.now.rejectStops")}</span>
          </div>
          {editable.length > 0 && (
            <button type="button" className={secondaryButton} onClick={() => setEditing(true)}>
              {t("automations.actions.edit")}
            </button>
          )}
          <button type="button" className={primaryButton} onClick={() => approve()}>
            {t("automations.actions.approve")}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * «Scegli il progetto» (solo il proprietario): i progetti in cui può creare,
 * per codice; «Remember for <client>» solo con `integrations.manage` [A 26].
 */
export function ChooseProject({
  runId,
  cursor,
  code,
  client,
  label,
  onDone,
}: {
  runId: string;
  /** Il passo che aspetta il progetto, come per `ApprovalBox`. */
  cursor: string;
  code: string;
  client: string;
  /** L'etichetta del menu, se la domanda è già scritta sopra («Da decidere»). */
  label?: string;
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const perms = useAutomationPerms();
  const decide = useDeferredDecision(runId, code);
  const projects = (useProjects().data ?? [])
    .filter((p) => perms.createTasks(p.id))
    .sort((a, b) => a.code.localeCompare(b.code));
  const [projectId, setProjectId] = useState("");
  const [remember, setRemember] = useState(false);
  const id = useId();
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label htmlFor={id} className="flex min-w-64 flex-col gap-1 text-sm text-ink-muted">
        {label ??
          (client
            ? t("automations.now.whichProject", { client })
            : t("automations.decide.whichProjectNoClient"))}
        <select
          id={id}
          className={`${inputClass} h-8`}
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">{t("automations.now.pickProject")}</option>
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
        disabled={!projectId}
        onClick={() => {
          const keep = perms.integrations && !!client && remember;
          decide("automations.toast.projectChosen", (now) =>
            now.choose(runId, cursor, projectId, keep),
          );
          onDone?.();
        }}
      >
        {t("automations.actions.choose")}
      </button>
      {/* Senza un cliente conosciuto non c'è niente da ricordare. */}
      {perms.integrations && client && (
        <label className="flex h-8 items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="accent-ink"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          {t("automations.now.remember", { client })}
        </label>
      )}
    </div>
  );
}
