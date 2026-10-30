import type { TFunction } from "i18next";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePauserName } from "../../../components/InstanceBlock";
import { WhoCanLink } from "../../../components/WhoCanLink";
import {
  usePauseQueue,
  usePeople,
  useResumeQueue,
  type InstanceResult,
  type InstanceStatusView,
} from "../../../data/queries";
import { useViewer } from "../../../data/viewer";
import { formatDateTime } from "../../../notifications/time";
import { Dialog } from "../../../tasks-ui/Dialog";
import { useToast } from "../../../tasks-ui/Toast";
import { ErrorLine } from "../../entry/parts";
import { refusalOf } from "../../preferences/parts";
import { primaryButton, secondaryButton } from "../../tasks/controls";

// QUEUES dello Stato dell'istanza (area 9b, Task 13, shape admin-instance.md
// «QUEUES / CODE»): una riga per progetto visibile con lavoro o in pausa,
// nell'ordine del livello dati (in pausa, con falliti, per codice), coi
// conteggi in parole e chi ha messo la pausa; in fondo «Other projects», i
// soli conteggi dei progetti che chi guarda non vede (R-G5). Pause e Resume
// hanno la conferma, senza riconferma [IS 7], e agiscono solo sulla coda di
// Stubwise: nessun server, worker o processo. Se si possono usare lo dice
// la vista (`pause`), non la pagina; spenti, la frase e il «Who?».

type Queue = InstanceStatusView["queues"][number];
type Counts = Pick<Queue, "running" | "waiting" | "failed">;

/** «today at 18:00», «yesterday at 18:00», «Oct 21, 16:00»: rispetto all'adesso della vista. */
export function whenWords(t: TFunction, iso: string, reference: string, language: string): string {
  const day = (x: string) => Date.parse(`${x.slice(0, 10)}T00:00:00Z`);
  const days = Math.round((day(reference) - day(iso)) / 86_400_000);
  const time = iso.slice(11, 16);
  if (days === 0) return t("admin.status.at.today", { time });
  if (days === 1) return t("admin.status.at.yesterday", { time });
  return t("admin.status.at.date", { date: formatDateTime(iso, language) });
}

/** «1 running · 2 waiting · 1 failed»: uno zero si omette, tutto zero «Nothing running». */
export function countsWords(t: TFunction, c: Counts): string {
  const parts = [
    c.running > 0 && t("admin.status.queues.running", { count: c.running }),
    c.waiting > 0 && t("admin.status.queues.waiting", { count: c.waiting }),
    c.failed > 0 && t("admin.status.queues.failed", { count: c.failed }),
  ].filter((p): p is string => typeof p === "string");
  return parts.length > 0 ? parts.join(" · ") : t("admin.status.queues.nothing");
}

/** Il glifo della pausa (‖), disegnato. */
export function PauseGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <rect x="4" y="3" width="2.5" height="10" rx="0.75" />
      <rect x="9.5" y="3" width="2.5" height="10" rx="0.75" />
    </svg>
  );
}

/** Le parole di un rifiuto di Pause/Resume/Retry (shape §5 «Rifiuti»). */
export function refusalWords(
  t: TFunction,
  result: InstanceResult | null,
  code: string,
): string | null {
  if (result === null) return t("admin.status.refused.failed");
  const refusal = refusalOf(result);
  if (!refusal) return null;
  if (refusal.error === "forbidden" || refusal.error === "not_found")
    return t("admin.status.refused.forbidden");
  if (refusal.error === "conflict") return t("admin.status.work.conflict", { code });
  if (refusal.error === "invalid") {
    if (refusal.reason === "already_paused" || refusal.reason === "not_paused")
      return t(`admin.status.queues.${refusal.reason}`, { code });
    if (refusal.reason === "not_retryable") return t("admin.status.work.notRetryable", { code });
  }
  return t("admin.status.refused.failed");
}

/** Il nome di chi ha messo la pausa, con «(deactivated)» se nel frattempo è stato disattivato. */
function usePausedBy(paused: NonNullable<Queue["paused"]>): string {
  return usePauserName({
    reason: "queue_paused",
    byId: paused.byId,
    byName: paused.byName,
    since: paused.at,
  });
}

type Open = { kind: "pause" | "resume"; queue: Queue };

export function QueueTable({ view }: { view: InstanceStatusView }) {
  const { t } = useTranslation();
  const headingId = useId();
  // Il dialogo tiene la riga com'era all'apertura: l'aggiornamento ogni 10
  // secondi non ne cambia il contenuto (shape «Confine, aggiornamento»).
  const [open, setOpen] = useState<Open | null>(null);

  return (
    <section aria-labelledby={headingId} className="flex flex-col">
      <h2 id={headingId} tabIndex={-1} className="heading-group pb-2 outline-none">
        {t("admin.status.queues.heading")}
      </h2>
      {view.queues.length === 0 && view.otherProjects === null ? (
        <p className="border-t border-rule py-4 text-md text-ink-muted">
          {t("admin.status.queues.empty")}
        </p>
      ) : (
        <ul aria-labelledby={headingId} className="border-t border-rule">
          {view.queues.map((q) => (
            <QueueRow
              key={q.projectId}
              queue={q}
              reference={view.refreshedAt}
              onOpen={(kind) => setOpen({ kind, queue: q })}
            />
          ))}
          {view.otherProjects && (
            <li
              data-queue-row="other"
              title={t("admin.status.queues.otherTitle")}
              className="flex min-h-14 flex-col justify-center gap-0.5 border-b border-rule px-1 py-2"
            >
              <span className="text-md text-ink-muted">{t("admin.status.queues.other")}</span>
              <span className="num text-sm text-ink-muted">
                {countsWords(t, view.otherProjects)}
              </span>
            </li>
          )}
        </ul>
      )}
      <p className="mt-2 text-xs text-ink-faint">{t("admin.status.queues.note")}</p>
      {open?.kind === "pause" && <PauseDialog queue={open.queue} onClose={() => setOpen(null)} />}
      {open?.kind === "resume" && <ResumeDialog queue={open.queue} onClose={() => setOpen(null)} />}
    </section>
  );
}

function QueueRow({
  queue: q,
  reference,
  onOpen,
}: {
  queue: Queue;
  reference: string;
  onOpen: (kind: "pause" | "resume") => void;
}) {
  const { t } = useTranslation();
  const nameId = useId();
  const allowed = q.pause === "allowed";
  const kind = q.paused ? "resume" : "pause";
  return (
    <li
      data-queue-row={q.code}
      aria-labelledby={nameId}
      className="@container flex min-h-14 flex-col justify-center gap-1 border-b border-rule px-1 py-2"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span id={nameId} className="flex min-w-0 items-baseline gap-2 text-md text-ink">
            <span className="num shrink-0 text-xs font-semibold tracking-[0.02em]">{q.code}</span>
            <span title={q.name} className="min-w-0 truncate">
              {q.name}
            </span>
          </span>
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm text-ink-muted">
            <span className="num">{countsWords(t, q)}</span>
            {q.paused && <PausedLine paused={q.paused} reference={reference} />}
          </span>
        </div>
        <PauseButton queue={q} kind={kind} allowed={allowed} onOpen={onOpen} />
      </div>
      {!allowed && (
        <p className="text-right text-xs text-pretty text-ink-muted">
          {t("admin.status.queues.forbidden")}{" "}
          <WhoCanLink action="manageSettings" projectId={null} />
        </p>
      )}
    </li>
  );
}

function PausedLine({
  paused,
  reference,
}: {
  paused: NonNullable<Queue["paused"]>;
  reference: string;
}) {
  const { t, i18n } = useTranslation();
  const name = usePausedBy(paused);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-ink">
      <PauseGlyph />
      <span className="min-w-0">
        {t("admin.status.queues.paused", {
          name,
          when: whenWords(t, paused.at, reference, i18n.language),
        })}
      </span>
    </span>
  );
}

/** Pause o Resume sulla riga, spento senza `settings.manage` (lo dice la vista). */
function PauseButton({
  queue: q,
  kind,
  allowed,
  onOpen,
}: {
  queue: Queue;
  kind: "pause" | "resume";
  allowed: boolean;
  onOpen: (kind: "pause" | "resume") => void;
}) {
  const { t } = useTranslation();
  const label = t(kind === "pause" ? "admin.status.queues.pause" : "admin.status.queues.resume");
  return (
    <button
      type="button"
      disabled={!allowed}
      aria-label={t(
        kind === "pause" ? "admin.status.queues.pauseOf" : "admin.status.queues.resumeOf",
        { code: q.code },
      )}
      title={allowed ? undefined : t("admin.status.queues.forbidden")}
      onClick={() => onOpen(kind)}
      className={`${secondaryButton} h-7 px-2.5 disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {label}
    </button>
  );
}

/** Una riga di conseguenza nel dialogo: frase sola, in tono pieno. */
function Consequence({ children }: { children: string }) {
  return <li className="text-md text-pretty text-ink">{children}</li>;
}

function useQueueAction(
  write: (projectId: string) => Promise<InstanceResult>,
  queue: Queue,
  done: string,
  onClose: () => void,
) {
  const { t } = useTranslation();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function submit() {
    setError(null);
    setPending(true);
    const result = await write(queue.projectId).catch(() => null);
    setPending(false);
    const words = refusalWords(t, result, queue.code);
    if (words) return setError(words);
    onClose();
    toast.show(done);
  }
  return { error, pending, submit };
}

function PauseDialog({ queue: q, onClose }: { queue: Queue; onClose: () => void }) {
  const { t } = useTranslation();
  const pause = usePauseQueue();
  const me = useMyName();
  const { error, pending, submit } = useQueueAction(
    (id) => pause.mutateAsync(id),
    q,
    t("admin.status.queues.pauseDialog.done", { code: q.code }),
    onClose,
  );
  return (
    <Dialog
      title={t("admin.status.queues.pauseDialog.title", { code: q.code })}
      width={480}
      onClose={onClose}
      footer={
        <>
          <button type="button" data-autofocus onClick={onClose} className={secondaryButton}>
            {t("admin.status.cancel")}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => void submit()}
            className={`${primaryButton} disabled:opacity-60`}
          >
            {t("admin.status.queues.pauseDialog.confirm")}
          </button>
        </>
      }
    >
      <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-ink-faint">
        <Consequence>{t("admin.status.queues.pauseDialog.running")}</Consequence>
        <Consequence>{t("admin.status.queues.pauseDialog.waits")}</Consequence>
        <Consequence>{t("admin.status.queues.pauseDialog.ask")}</Consequence>
        <Consequence>
          {t("admin.status.queues.pauseDialog.everyone", { code: q.code, name: me })}
        </Consequence>
      </ul>
      {error && <ErrorLine>{error}</ErrorLine>}
    </Dialog>
  );
}

function ResumeDialog({ queue: q, onClose }: { queue: Queue; onClose: () => void }) {
  const { t } = useTranslation();
  const resume = useResumeQueue();
  const { error, pending, submit } = useQueueAction(
    (id) => resume.mutateAsync(id),
    q,
    t("admin.status.queues.resumeDialog.done", { code: q.code }),
    onClose,
  );
  // Col budget raggiunto i lavori in attesa restano fermi anche dopo la
  // ripresa (`budgetAfterResume`, dal livello dati): il dialogo non dice
  // che partono.
  const starting = q.waiting - q.budgetAfterResume;
  return (
    <Dialog
      title={t("admin.status.queues.resumeDialog.title", { code: q.code })}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" data-autofocus onClick={onClose} className={secondaryButton}>
            {t("admin.status.cancel")}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => void submit()}
            className={`${primaryButton} disabled:opacity-60`}
          >
            {t("admin.status.queues.resumeDialog.confirm")}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-md text-pretty text-ink">
        {q.waiting === 0 && <p>{t("admin.status.queues.resumeDialog.none")}</p>}
        {starting > 0 && <p>{t("admin.status.queues.resumeDialog.start", { count: starting })}</p>}
        {q.budgetAfterResume > 0 && (
          <p>{t("admin.status.queues.resumeDialog.budget", { count: q.budgetAfterResume })}</p>
        )}
      </div>
      {error && <ErrorLine>{error}</ErrorLine>}
    </Dialog>
  );
}

/** Il nome di chi guarda: la pausa sarà a nome suo («Everyone in STW reads “Queue paused by …”»). */
function useMyName(): string {
  const { viewer } = useViewer();
  return usePeople().data?.find((p) => p.id === viewer.personId)?.name ?? "";
}
