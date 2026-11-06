import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { WithWho } from "../../../components/InstanceBlock";
import { WhoCanLink } from "../../../components/WhoCanLink";
import { useFirstVersionSources, useStartFirstVersion } from "../../../data/queries";
import type { FirstVersionSource, Project } from "../../../data/types";
import { formatDate } from "../../../notifications/time";
import { Dialog } from "../../../tasks-ui/Dialog";
import { primaryButton, secondaryButton } from "../../tasks/controls";

// La finestra delle fonti della prima versione (11b, Task 11; shape
// product-claude-questions.md §3.6, [PQ 7]): quattro gruppi — le email e le
// riunioni del progetto che chi chiede APRE, un testo incollato, i file del
// Drive — tutti dal livello dati (`listFirstVersionSources`), che non dà mai
// una fonte che chi chiede non vede. Sopra i bottoni, sempre, la nota sulla
// riservatezza (decisione 1). «Write the first version» senza fonti è
// spento con la sua frase; in corso «Starting…», e i controlli restano
// raggiungibili (`aria-disabled`, mai `disabled`: il fuoco non cade sul
// body). Un doppio clic avvia una volta. Avviata, la finestra resta finché
// l'indice non ha messo il fuoco sul titolo dell'avanzamento (lo chiude
// l'indice, `onStarted`): il bottone che aveva il fuoco smonta dopo.

type Refusal = "space_not_empty" | "ai_blocked" | "forbidden" | "failed";

const refusalOf = (error: unknown): Refusal => {
  const message = error instanceof Error ? error.message : "";
  return message === "space_not_empty" || message === "ai_blocked" || message === "forbidden"
    ? message
    : "failed";
};

const rowClass =
  "flex min-h-9 min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4";
const linkButton = "font-medium text-ink underline underline-offset-2";

export function FirstVersionDialog({
  project,
  onClose,
  onStarted,
}: {
  project: Pick<Project, "id" | "code">;
  onClose: () => void;
  /** Avviata: l'indice porta il fuoco sull'avanzamento, poi chiude la finestra. */
  onStarted: () => void;
}) {
  const { t, i18n } = useTranslation();
  const sources = useFirstVersionSources(project.id);
  const start = useStartFirstVersion();
  const [emails, setEmails] = useState<ReadonlySet<string>>(new Set());
  const [meetings, setMeetings] = useState<ReadonlySet<string>>(new Set());
  const [files, setFiles] = useState<ReadonlySet<string>>(new Set());
  const [text, setText] = useState("");
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [started, setStarted] = useState(false);
  const inflight = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  const noneId = useId();
  const textId = useId();

  const busy = start.isPending || started;
  const count = emails.size + meetings.size + files.size + (text.trim() === "" ? 0 : 1);

  // Le fonti arrivano dopo l'apertura: il fuoco entra sulla prima casella, se
  // nel frattempo nessuno l'ha spostato da dove l'ha messo il dialogo.
  const sourcesReady = sources.isSuccess;
  const autoFocused = useRef<Element | null>(null);
  useEffect(() => {
    // Il dialogo ha già messo il fuoco (il suo effetto di layout viene prima).
    autoFocused.current = document.activeElement;
  }, []);
  useEffect(() => {
    if (!sourcesReady || document.activeElement !== autoFocused.current) return;
    body.current?.querySelector<HTMLElement>('input[type="checkbox"], textarea')?.focus();
  }, [sourcesReady]);

  const toggle = (set: ReadonlySet<string>, id: string, write: (next: ReadonlySet<string>) => void) => {
    if (busy) return;
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    write(next);
  };

  const submit = () => {
    if (count === 0 || inflight.current) return;
    inflight.current = true;
    setRefusal(null);
    const chosen: FirstVersionSource[] = [
      ...[...emails].map((id): FirstVersionSource => ({ kind: "email", id })),
      ...[...meetings].map((id): FirstVersionSource => ({ kind: "meeting", id })),
      ...(text.trim() === "" ? [] : [{ kind: "text", text } as const]),
      ...[...files].map((fileId): FirstVersionSource => ({ kind: "drive", fileId })),
    ];
    start.mutateAsync({ projectId: project.id, sources: chosen }).then(
      () => {
        setStarted(true);
        onStarted();
      },
      (error: unknown) => {
        inflight.current = false;
        setRefusal(refusalOf(error));
      },
    );
  };

  const data = sources.data;
  const startOff = count === 0 || busy;
  return (
    <Dialog
      title={t("productDocs.firstVersion.dialog.title")}
      description={t("productDocs.firstVersion.dialog.intro")}
      onClose={onClose}
      width={560}
      scrollBody
      footer={
        <>
          {count === 0 ? (
            <span id={noneId} className="mr-auto text-xs text-ink-muted">
              {t("productDocs.firstVersion.dialog.none")}
            </span>
          ) : (
            <span className="num mr-auto text-xs text-ink-muted">
              {t("productDocs.firstVersion.dialog.count", { count })}
            </span>
          )}
          <button type="button" onClick={onClose} className={secondaryButton}>
            {t("productDocs.firstVersion.dialog.cancel")}
          </button>
          <button
            type="button"
            aria-disabled={startOff || undefined}
            aria-describedby={count === 0 ? noneId : undefined}
            onClick={submit}
            className={`${primaryButton} aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:opacity-40`}
          >
            {busy
              ? t("productDocs.firstVersion.dialog.starting")
              : t("productDocs.firstVersion.dialog.start")}
          </button>
        </>
      }
    >
      <div ref={body} className="flex flex-col gap-4">
        {sources.isError ? (
          <p role="alert" className="flex flex-wrap items-center gap-x-1.5 text-sm text-critical">
            <span>{t("productDocs.firstVersion.dialog.loadError")}</span>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={() => void sources.refetch()} className={linkButton}>
              {t("productDocs.firstVersion.dialog.retry")}
            </button>
          </p>
        ) : (
          <>
            <SourceGroup
              label={t("productDocs.firstVersion.dialog.emails")}
              loading={!data}
              empty={data?.emails.length === 0 ? t("productDocs.firstVersion.dialog.noEmails", { code: project.code }) : null}
            >
              {data?.emails.map((m) => (
                <label key={m.id} className={rowClass}>
                  <Check checked={emails.has(m.id)} busy={busy} onChange={() => toggle(emails, m.id, setEmails)} />
                  <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <span className="shrink-0 font-semibold text-ink">{m.fromName}</span>
                    <span aria-hidden="true" className="text-ink-faint">
                      ·
                    </span>
                    <span className="min-w-0 truncate text-ink" title={m.subject}>
                      {m.subject}
                    </span>
                  </span>
                  <span className="num shrink-0 text-xs text-ink-faint">{formatDate(m.at, i18n.language)}</span>
                </label>
              ))}
            </SourceGroup>
            <SourceGroup
              label={t("productDocs.firstVersion.dialog.meetings")}
              loading={!data}
              empty={data?.meetings.length === 0 ? t("productDocs.firstVersion.dialog.noMeetings", { code: project.code }) : null}
            >
              {data?.meetings.map((m) => (
                <label key={m.id} className={rowClass}>
                  <Check checked={meetings.has(m.id)} busy={busy} onChange={() => toggle(meetings, m.id, setMeetings)} />
                  <span className="min-w-0 flex-1 truncate text-ink" title={m.title}>
                    {m.title}
                  </span>
                  <span className="num shrink-0 text-xs text-ink-faint">
                    {formatDate(m.at, i18n.language)}
                    {m.transcript && ` · ${t("productDocs.firstVersion.dialog.transcript")}`}
                  </span>
                </label>
              ))}
            </SourceGroup>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={textId} className="heading-group">
                {t("productDocs.firstVersion.dialog.text")}
              </label>
              <textarea
                id={textId}
                rows={4}
                value={text}
                readOnly={busy}
                onChange={(e) => setText(e.target.value)}
                placeholder={t("productDocs.firstVersion.dialog.placeholder")}
                className="field-sizing-content max-h-60 min-h-[92px] w-full min-w-0 resize-none rounded-md border border-rule-strong bg-transparent px-2.5 py-1.5 text-md text-ink placeholder:text-ink-faint transition-colors duration-[var(--duration-fast)] ease-out hover:border-ink/40 focus-visible:border-transparent"
              />
            </div>
            <SourceGroup
              label={t("productDocs.firstVersion.dialog.files")}
              loading={!data}
              empty={data?.files.length === 0 ? t("productDocs.firstVersion.dialog.noFiles", { code: project.code }) : null}
            >
              {data?.files.map((f) => (
                <label key={f.id} className={rowClass}>
                  <Check checked={files.has(f.id)} busy={busy} onChange={() => toggle(files, f.id, setFiles)} />
                  <span className="num w-[60px] shrink-0 text-xs font-semibold tracking-[0.02em] text-ink-muted">
                    {f.code}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ink" title={f.name}>
                    {f.name}
                  </span>
                  <span className="shrink-0 text-xs text-ink-faint">{t(`drive.types.${f.type}`)}</span>
                </label>
              ))}
            </SourceGroup>
          </>
        )}
        <p className="text-xs text-pretty text-ink-muted">
          {t("productDocs.firstVersion.dialog.privacy", { code: project.code })}
        </p>
        {refusal && (
          <RefusalLine
            refusal={refusal}
            project={project}
            onRetry={submit}
            onClose={onClose}
          />
        )}
      </div>
    </Dialog>
  );
}

function Check({ checked, busy, onChange }: { checked: boolean; busy: boolean; onChange: () => void }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-disabled={busy || undefined}
      onChange={onChange}
      className="size-4 shrink-0"
    />
  );
}

/** Un gruppo di fonti: il titolo, le righe a casella (oltre 6 scorrono), il vuoto o lo scheletro. */
function SourceGroup({
  label,
  loading,
  empty,
  children,
}: {
  label: string;
  loading: boolean;
  empty: string | null;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1.5">
      <h3 id={id} className="heading-group">
        {label}
      </h3>
      {loading ? (
        <div aria-hidden="true" className="flex flex-col gap-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 rounded-md bg-ink/5" />
          ))}
        </div>
      ) : empty ? (
        <p className="px-2 text-sm text-ink-muted">{empty}</p>
      ) : (
        <div className="flex max-h-[216px] flex-col overflow-y-auto">{children}</div>
      )}
    </div>
  );
}

function RefusalLine({
  refusal,
  project,
  onRetry,
  onClose,
}: {
  refusal: Refusal;
  project: Pick<Project, "id" | "code">;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  let content: ReactNode;
  switch (refusal) {
    case "ai_blocked":
      content = (
        <span className="min-w-0">
          <WithWho text={t("claude.panel.budget")} />
        </span>
      );
      break;
    case "forbidden":
      content = (
        <span className="min-w-0">
          {t("productDocs.firstVersion.dialog.forbidden", { code: project.code })}{" "}
          <span aria-hidden="true">· </span>
          <WhoCanLink action="editDocs" projectId={project.id} projectCode={project.code} />
        </span>
      );
      break;
    case "space_not_empty":
      content = (
        <>
          <span className="min-w-0">{t("productDocs.firstVersion.dialog.spaceNotEmpty")}</span>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={onClose} className={linkButton}>
            {t("productDocs.firstVersion.dialog.close")}
          </button>
        </>
      );
      break;
    default:
      content = (
        <>
          <span>{t("productDocs.firstVersion.dialog.failed")}</span>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={onRetry} className={linkButton}>
            {t("productDocs.firstVersion.dialog.retry")}
          </button>
        </>
      );
  }
  return (
    <p
      role="alert"
      className={`flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-sm ${refusal === "failed" ? "text-critical" : "text-ink"}`}
    >
      {content}
    </p>
  );
}
