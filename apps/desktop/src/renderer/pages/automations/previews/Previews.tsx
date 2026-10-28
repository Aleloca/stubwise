import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { show } from "../../../domain/automations/preview";
import { DeptStrip } from "../../../layout/DeptStrip";
import type {
  SimulationClaudePreview,
  SimulationEffectPreview,
  SimulationEmailPreview,
  SimulationMilestonePreview,
  SimulationProject,
  SimulationRequestPreview,
  SimulationTaskPreview,
} from "../../../data/types";
import type { DataField } from "../../../data/types";
import { reasonWords, shortDate, type Names } from "../format";
import { CriticalGlyph, WarningGlyph } from "../glyphs";

// Le anteprime di ciò che un passo FAREBBE (shape automation-test §5,
// «Anteprime»): una task, un traguardo, una richiesta, un'email, un avviso,
// un avvio, la scelta di Claude; al condizionale, risolte con le regole
// dell'esecuzione vera. Nessun codice (al posto del codice «New task» [A 9])
// e nessun link verso oggetti che non esistono: i soli nomi veri sono
// progetti e persone. Componenti di sole props, senza contesto: le usa la
// prova, il riquadro «Now» di un'esecuzione e «Da decidere» (Task 8) — una
// sola anteprima di task, una sola di email.

/** Le parole che un'anteprima cita: nomi, numeri dei passi (1…N), etichette dei dati. */
export interface PreviewWords {
  names: Names;
  /** Id del passo → numero 1…N (R-J17). */
  numberOf: (stepId: string) => number | undefined;
  /** Le etichette dei dati del flusso, per chiave (i campi di Claude). */
  labels: Map<string, DataField>;
}

const showMore = "self-start text-sm text-ink underline-offset-4 hover:underline";

/** «AUD Audin 2.0», o «un progetto che non vedi» (R-G5). */
function useProjectWords() {
  const { t } = useTranslation();
  return (p: SimulationProject | null) =>
    p && p.id ? `${p.code} ${p.name}` : t("automations.test.preview.hiddenProject");
}

/** Una riga etichetta · valore. */
function Pair({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

const pairs = "grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm";

/** Un testo lungo chiuso a `lines` righe, con «Show all». */
function Clamped({
  text,
  lines,
  className = "",
}: {
  text: string;
  lines: 3 | 6 | 10;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const long = text.length > { 3: 180, 6: 360, 10: 680 }[lines] || text.split("\n").length > lines;
  const clamp = { 3: "line-clamp-3", 6: "line-clamp-6", 10: "line-clamp-[10]" }[lines];
  return (
    <>
      <p
        className={`max-w-[68ch] whitespace-pre-line text-ink ${className} ${
          long && !open ? clamp : ""
        }`}
      >
        {text}
      </p>
      {long && (
        <button type="button" className={showMore} onClick={() => setOpen((v) => !v)}>
          {open ? t("automations.test.preview.showLess") : t("automations.test.preview.showAll")}
        </button>
      )}
    </>
  );
}

/** «Due Oct 31 (5 days after it's created)». */
function DueWords({ date, days }: { date: string | null; days: number | null }) {
  const { t, i18n } = useTranslation();
  if (!date) return <>{t("automations.test.preview.noDue")}</>;
  const d = shortDate(`${date}T12:00:00Z`, i18n.language);
  return <>{days === null ? d : t("automations.test.preview.dueIn", { date: d, count: days })}</>;
}

export function TaskPreview({ p, words }: { p: SimulationTaskPreview; words: PreviewWords }) {
  const { t } = useTranslation();
  const ctx = words;
  const project = useProjectWords();
  const assignee =
    p.assignedBy === "person"
      ? t("automations.test.preview.byPerson", { name: ctx.names.person(p.assigneeId) })
      : p.assignedBy === "department"
        ? t("automations.test.preview.byDepartment", {
            dept: ctx.names.department(p.departmentId ?? ""),
          })
        : p.assignedBy === "role" && p.assigneeId
          ? t("automations.test.preview.byRole", {
              name: ctx.names.person(p.assigneeId),
              role: t(`automations.roles.${p.role}`, { defaultValue: p.role ?? "" }),
              code: p.project.code || t("automations.test.preview.hiddenProject"),
            })
          : t("automations.test.preview.byNone");
  return (
    <section data-preview-task className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">
        {t("automations.test.preview.taskIn", { project: project(p.project) })}
      </p>
      <div className="relative flex flex-col gap-0.5 pl-3">
        <DeptStrip departmentId={p.departmentId} />
        <span className="text-xs font-medium text-ink-faint">
          {t("automations.test.preview.newTask")}
        </span>
        <span className="text-md font-semibold text-ink [overflow-wrap:anywhere]">{p.title}</span>
      </div>
      <dl className={pairs}>
        <Pair label={t("automations.test.preview.assignee")}>{assignee}</Pair>
        <Pair label={t("automations.test.preview.due")}>
          <DueWords date={p.dueDate} days={p.dueInDays} />
        </Pair>
        {p.milestone && (
          <Pair label={t("automations.test.preview.milestone")}>
            {t("automations.test.preview.milestoneFrom", {
              name: p.milestone.name,
              n: ctx.numberOf(p.milestone.stepId) ?? "",
            })}
          </Pair>
        )}
        {p.departmentId && (
          <Pair label={t("automations.test.preview.department")}>
            {ctx.names.department(p.departmentId)}
          </Pair>
        )}
      </dl>
      {p.warning && (
        <p data-preview-warning className="flex items-start gap-2 text-sm text-warning">
          <WarningGlyph />
          <span className="text-ink">{reasonWords(p.warning, t, { would: true })}</span>
        </p>
      )}
      {p.description && (
        <div className="flex flex-col gap-1">
          <p className="heading-group">{t("automations.test.preview.description")}</p>
          <Clamped text={p.description} lines={6} className="text-sm" />
        </div>
      )}
    </section>
  );
}

export function MilestonePreview({ p }: { p: SimulationMilestonePreview }) {
  const { t } = useTranslation();
  const project = useProjectWords();
  return (
    <section data-preview-milestone className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">
        {t("automations.test.preview.milestoneIn", { project: project(p.project) })}
      </p>
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-ink-faint">
          {t("automations.test.preview.newMilestone")}
        </span>
        <span className="text-md font-semibold text-ink [overflow-wrap:anywhere]">{p.name}</span>
      </div>
      <dl className={pairs}>
        <Pair label={t("automations.test.preview.due")}>
          <DueWords date={p.dueDate} days={p.dueInDays} />
        </Pair>
      </dl>
    </section>
  );
}

export function RequestPreview({ p }: { p: SimulationRequestPreview }) {
  const { t } = useTranslation();
  const project = useProjectWords();
  return (
    <section data-preview-request className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">
        {t("automations.test.preview.requestIn", { project: project(p.project) })}
      </p>
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-ink-faint">
          {t("automations.test.preview.newRequest")}
        </span>
        <span className="text-md font-semibold text-ink [overflow-wrap:anywhere]">{p.title}</span>
      </div>
      {p.description && <Clamped text={p.description} lines={6} className="text-sm" />}
    </section>
  );
}

/** L'email intera, come nel pannello di lettura della Posta (prosa ≤ 68ch). Nessun «Open in Mail». */
export function EmailPreview({
  p,
  words,
  fromYours = false,
  edited,
  clampBody = false,
}: {
  p: SimulationEmailPreview;
  words: PreviewWords;
  /** «Da decidere»: il corpo chiuso alle prime 3 righe, con «Show all». */
  clampBody?: boolean;
  /** Partirebbe dalla casella di chi guarda perché ne sarebbe il proprietario (una bozza mai accesa). */
  fromYours?: boolean;
  /** Oggetto e testo corretti prima di approvare. */
  edited?: { subject?: string; body?: string; to?: string };
}) {
  const { t } = useTranslation();
  const yours = fromYours;
  const same = p.sameConversationAs ? words.numberOf(p.sameConversationAs.stepId) : undefined;
  return (
    <section data-preview-email className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">{t("automations.test.preview.email")}</p>
      <dl className={pairs}>
        {/* Senza una casella nota (un proprietario senza posta collegata) la riga non c'è. */}
        {p.from && (
          <Pair label={t("automations.test.preview.from")}>
            {yours ? t("automations.test.preview.fromOwner", { email: p.from }) : p.from}
          </Pair>
        )}
        <Pair label={t("automations.test.preview.to")}>{edited?.to ?? p.to}</Pair>
        <Pair label={t("automations.test.preview.subject")}>
          <span className="font-semibold">{edited?.subject ?? p.subject}</span>
        </Pair>
      </dl>
      <div className="border-t border-rule pt-3">
        {clampBody ? (
          <div data-email-body className="flex flex-col gap-1">
            <Clamped text={edited?.body ?? p.body} lines={3} className="text-md" />
          </div>
        ) : (
          <p data-email-body className="max-w-[68ch] text-md whitespace-pre-line text-ink">
            {edited?.body ?? p.body}
          </p>
        )}
      </div>
      {p.attachments.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="heading-group">{t("automations.test.preview.attachments")}</p>
          <ul className="flex flex-wrap gap-1.5">
            {p.attachments.map((a) => (
              <li
                key={a}
                className="inline-flex h-7 items-center rounded-md border border-rule px-2 text-sm text-ink"
              >
                {a}
              </li>
            ))}
          </ul>
        </div>
      )}
      {same !== undefined && (
        <p className="text-sm text-ink-muted">
          {t("automations.test.preview.sameConversation", { n: same })}
        </p>
      )}
    </section>
  );
}

/** Un campo restituito da Claude: testo, o un elenco come tabella compatta («Show all 23» oltre 10). */
function ReturnedField({
  name,
  value,
  labels,
}: {
  name: string;
  value: unknown;
  labels: Map<string, DataField>;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const field = labels.get(name);
  const label = field?.label ?? name;
  if (Array.isArray(value)) {
    const rows = value as Record<string, unknown>[];
    const cols = field?.of ?? Object.keys(rows[0] ?? {}).map((k) => ({ key: k, label: k }));
    const shown = all ? rows : rows.slice(0, 10);
    return (
      <div className="flex flex-col gap-1">
        <p className="text-sm text-ink-muted">{label}</p>
        <table className="max-w-[640px] text-sm">
          <thead>
            <tr>
              {cols.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className="border-b border-rule py-1 pr-4 text-left font-medium text-ink-muted"
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c.key} className="border-b border-rule py-1 pr-4 text-ink">
                    {r && typeof r === "object" ? show(r[c.key]) : show(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 10 && (
          <button type="button" className={showMore} onClick={() => setAll((v) => !v)}>
            {all
              ? t("automations.log.showFewer")
              : t("automations.log.showAllRows", { count: rows.length })}
          </button>
        )}
      </div>
    );
  }
  return (
    <p className="text-sm [overflow-wrap:anywhere]">
      <span className="text-ink-muted">{label}: </span>
      <span className="text-ink">{show(value)}</span>
    </p>
  );
}

/**
 * Il passo di Claude (shape [A 1], regola 2) — lo stesso nel registro e
 * nella prova: le uscite possibili con quella scelta in evidenza, il perché
 * scritto da Claude (come tale, mai interpretato), i campi, cosa ha letto.
 */
export function ClaudePreview({
  p,
  words,
  reason,
  outcomes = [],
}: {
  p: SimulationClaudePreview;
  words: PreviewWords;
  /** La motivazione mentre arriva (streaming); assente = intera. */
  reason?: string;
  /** Le uscite del passo, per mostrare la scelta fra quelle possibili. */
  outcomes?: readonly string[];
}) {
  const { t } = useTranslation();
  const fields = Object.entries(p.fields);
  const streaming = reason !== undefined && reason !== p.reason;
  return (
    <section data-preview-claude className="flex flex-col gap-3">
      {p.outcome !== null ? (
        <p className="text-md text-ink">
          {t("automations.test.preview.claudeChose")}{" "}
          <strong data-claude-outcome className="font-semibold">
            {p.outcome}
          </strong>
        </p>
      ) : (
        <p className="text-sm text-ink-muted">{t("automations.test.preview.claudeAnswered")}</p>
      )}
      {outcomes.length > 0 && (
        <p data-outcomes className="flex flex-wrap gap-x-2 text-sm">
          {outcomes.map((o, i) => (
            <span key={o} className={o === p.outcome ? "font-semibold text-ink" : "text-ink-faint"}>
              {o}
              {i < outcomes.length - 1 && <span className="text-ink-faint"> ·</span>}
            </span>
          ))}
        </p>
      )}
      {(streaming || p.reason) && (
        <div className="flex flex-col gap-1">
          <p className="heading-group">{t("automations.log.why")}</p>
          {streaming ? (
            <p aria-busy="true" className="max-w-[68ch] text-md whitespace-pre-line text-ink">
              {reason}
              <span
                aria-hidden="true"
                className="stream-caret ml-0.5 inline-block h-4 w-[2px] translate-y-[3px] rounded-[1px] bg-ink"
              />
            </p>
          ) : (
            <Clamped text={p.reason} lines={10} className="text-md" />
          )}
        </div>
      )}
      {!streaming && fields.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="heading-group">{t("automations.test.preview.fields")}</p>
          {fields.map(([k, v]) => (
            <ReturnedField key={k} name={k} value={v} labels={words.labels} />
          ))}
        </div>
      )}
      {!streaming && p.read.length > 0 && (
        <p className="text-sm text-ink-muted">
          {t("automations.test.preview.read")}: {p.read.join(", ")}
        </p>
      )}
    </section>
  );
}

/** Un'anteprima di un effetto, qualunque sia. */
export function EffectPreview({
  p,
  words,
  fromYours = false,
  edited,
  clampBody = false,
}: {
  p: SimulationEffectPreview;
  words: PreviewWords;
  fromYours?: boolean;
  edited?: { subject?: string; body?: string; to?: string };
  clampBody?: boolean;
}) {
  const { t } = useTranslation();
  const ctx = words;
  switch (p.kind) {
    case "task":
      return <TaskPreview p={p} words={words} />;
    case "milestone":
      return <MilestonePreview p={p} />;
    case "request":
      return <RequestPreview p={p} />;
    case "email":
      return (
        <EmailPreview
          p={p}
          words={words}
          fromYours={fromYours}
          edited={edited}
          clampBody={clampBody}
        />
      );
    case "notification":
      return (
        <section data-preview-notify className="flex flex-col gap-2">
          <p className="text-sm text-ink-muted">
            {t("automations.test.preview.notify", { name: ctx.names.person(p.personId) })}
          </p>
          <p className="max-w-[68ch] text-md text-ink">“{p.text}”</p>
        </section>
      );
    case "start":
      return (
        <p data-preview-start className="max-w-[68ch] text-md text-ink">
          {p.code
            ? t("automations.test.preview.start", { code: p.code, name: p.name })
            : t("automations.test.preview.startHidden")}
        </p>
      );
  }
}

/** Il fallimento di un passo: in parole, con la riga che dice che la vera si fermerebbe. */
export function FailurePreview({ reason, claude }: { reason: string | null; claude: boolean }) {
  const { t } = useTranslation();
  return (
    <section data-preview-failure className="flex flex-col gap-1.5">
      <p className="flex items-center gap-2 text-md font-semibold text-critical">
        <CriticalGlyph />
        {claude ? t("automations.test.preview.claudeOff") : t("automations.test.preview.failed")}
      </p>
      {reason && <p className="max-w-[68ch] text-md text-ink">{reason}</p>}
      <p className="text-sm text-ink-muted">{t("automations.test.preview.realStop")}</p>
    </section>
  );
}
