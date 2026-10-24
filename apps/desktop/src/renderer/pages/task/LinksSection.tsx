import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjects, useRequest, useTasks } from "../../data/queries";
import type { StoredLinkKind, Task } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { linksOf, withoutLink, type LinkView } from "../../domain/links";
import { inputClass } from "../../tasks-ui/Dialog";
import { MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { Chevron, MenuButton } from "../tasks/controls";
import { useInlineUpdate } from "../tasks/pickers";
import { CloseIcon, InlineConfirm, PlusIcon, Section, ghostButton, smallSecondary } from "./parts";

// Si salva solo il verso «diretto», come sul web: «bloccata da» e «figlia» si vedono
// dall'altra task, e aggiungerli da qui chiederebbe di poter modificare quella.
const LINK_KINDS: StoredLinkKind[] = ["blocks", "relates", "parent"];

/** «Report.pdf · 240 KB». */
export function formatBytes(bytes: number, language: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toLocaleString(language, { maximumFractionDigits: digits })} ${units[unit]}`;
}

// File finti per «Add» (il prototipo non legge il disco): si prende il primo che manca.
const FAKE_FILES = [
  { name: "Brief.pdf", sizeBytes: 248_320 },
  { name: "Screenshot.png", sizeBytes: 1_310_720 },
  { name: "Notes.docx", sizeBytes: 38_912 },
  { name: "Budget.xlsx", sizeBytes: 64_512 },
];

/** Richiesta d'origine, task collegate, allegati: tre sezioni, una riga se vuote. */
export function LinksSection({ task, canEdit }: { task: Task; canEdit: boolean }) {
  return (
    <>
      {task.requestId && <OriginRequest task={task} requestId={task.requestId} />}
      <LinkedTasks task={task} canEdit={canEdit} />
      <Attachments task={task} canEdit={canEdit} />
    </>
  );
}

function OriginRequest({ task, requestId }: { task: Task; requestId: string }) {
  const { t } = useTranslation();
  const request = useRequest(requestId).data;
  const project = useProjects().data?.find((p) => p.id === task.projectId);
  return (
    <Section title={t("taskDetail.links.origin")}>
      {request && project ? (
        <Link
          to="/p/$code/$section"
          params={{ code: project.code, section: "requests" }}
          search={{ request: request.id } as never}
          className="-mx-1.5 flex min-h-8 items-center rounded-md px-1.5 text-md text-ink underline-offset-4 hover:bg-ink/6 hover:underline"
        >
          <span className="min-w-0 truncate" title={request.title}>
            {request.title}
          </span>
        </Link>
      ) : (
        <span className="text-sm text-ink-faint">{t("taskDetail.links.originMissing")}</span>
      )}
    </Section>
  );
}

/**
 * Le task collegate, viste da questa: le righe sue e gli inversi ricavati
 * dalle altre (`linksOf`), solo fra le task che chi guarda vede. Togliere un
 * collegamento chiede conferma e modifica la task che tiene la riga: lo può
 * fare chi ha `tickets.edit` sul progetto di quella task.
 */
function LinkedTasks({ task, canEdit }: { task: Task; canEdit: boolean }) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const navigate = useNavigate();
  const change = useInlineUpdate();
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const { data: tasks } = useTasks();
  const byId = useMemo(() => new Map((tasks ?? []).map((x) => [x.id, x])), [tasks]);
  const open = (code: string) =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, task: code }),
    } as never);
  // La task del pannello è la più fresca: prende il posto della sua copia nell'elenco.
  const all = [task, ...(tasks ?? []).filter((x) => x.id !== task.id)];
  // Un collegamento a una task che chi guarda non vede non si mostra.
  const links = linksOf(task, all).filter((l) => byId.has(l.taskId));
  const keyOf = (l: LinkView) => `${l.holderId}:${l.row.kind}:${l.row.taskId}`;
  const holderOf = (l: LinkView) => (l.holderId === task.id ? task : byId.get(l.holderId));
  const canRemove = (l: LinkView) => {
    const holder = holderOf(l);
    return !!holder && can(viewer, "tickets.edit", holder.projectId);
  };
  const add = canEdit && !adding && (
    <button type="button" className={ghostButton} onClick={() => setAdding(true)}>
      <PlusIcon />
      {t("taskDetail.add")}
    </button>
  );
  return (
    <Section
      title={t("taskDetail.links.linked")}
      count={links.length}
      empty={links.length === 0 && !adding && tasks ? t("taskDetail.links.noLinked") : undefined}
      action={add}
    >
      {links.length > 0 && (
        <ul className="flex flex-col">
          {links.map((l) => {
            const other = byId.get(l.taskId)!;
            const kind = t(`taskDetail.links.kinds.${l.kind}`);
            if (confirming === keyOf(l)) {
              return (
                <li key={keyOf(l)} className="py-1">
                  <InlineConfirm
                    message={t("taskDetail.links.confirm", { kind, code: other.code })}
                    confirm={t("taskDetail.links.removeConfirm")}
                    cancelLabel={t("taskDetail.cancel")}
                    onCancel={() => setConfirming(null)}
                    onConfirm={() => {
                      setConfirming(null);
                      const holder = holderOf(l);
                      if (holder) change(holder, { links: withoutLink(holder, l.row) });
                    }}
                  />
                </li>
              );
            }
            return (
              <li key={keyOf(l)} className="group/link flex min-h-8 items-center gap-2">
                <span className="w-20 shrink-0 text-xs text-ink-muted">{kind}</span>
                <button
                  type="button"
                  onClick={() => open(other.code)}
                  className="-mx-1.5 flex min-h-7 min-w-0 flex-1 items-baseline gap-2 rounded-md px-1.5 text-left hover:bg-ink/6"
                >
                  <span className="num shrink-0 text-xs font-semibold text-ink-muted">
                    {other.code}
                  </span>
                  <span className="min-w-0 truncate text-sm text-ink" title={other.title}>
                    {other.title}
                  </span>
                </button>
                {canRemove(l) && (
                  <button
                    type="button"
                    aria-label={t("taskDetail.links.remove", { code: other.code })}
                    title={t("taskDetail.links.remove", { code: other.code })}
                    onClick={() => setConfirming(keyOf(l))}
                    className={`${ghostButton} w-7 justify-center px-0 opacity-60 group-hover/link:opacity-100 focus-visible:opacity-100`}
                  >
                    <CloseIcon size={12} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {adding && (
        <AddLink
          task={task}
          candidates={tasks ?? []}
          linkedIds={new Set(links.map((l) => l.taskId))}
          onAdd={(kind, taskId) => {
            change(task, { links: [...task.links, { kind, taskId }] });
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </Section>
  );
}

/** Aggiungere un collegamento: il tipo, poi una ricerca per codice o titolo. */
function AddLink({
  task,
  candidates,
  linkedIds,
  onAdd,
  onCancel,
}: {
  task: Task;
  candidates: Task[];
  /** Le task già collegate, in un verso o nell'altro. */
  linkedIds: Set<string>;
  onAdd: (kind: StoredLinkKind, taskId: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<StoredLinkKind>("relates");
  const [query, setQuery] = useState("");
  const inputId = useId();
  const q = query.trim().toLowerCase();
  const results = q
    ? candidates
        .filter(
          (c) =>
            c.id !== task.id &&
            !linkedIds.has(c.id) &&
            (c.code.toLowerCase().includes(q) || c.title.toLowerCase().includes(q)),
        )
        // Prima le task dello stesso progetto.
        .sort((a, b) => Number(b.projectId === task.projectId) - Number(a.projectId === task.projectId))
        .slice(0, 6)
    : [];
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-rule p-2.5"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="flex items-center gap-2">
        <MenuButton
          menuLabel={t("taskDetail.links.kind")}
          ariaLabel={t("taskDetail.links.kindValue", { kind: t(`taskDetail.links.kinds.${kind}`) })}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-rule-strong px-2.5 text-sm text-ink hover:border-ink/40 aria-expanded:border-ink/40"
          label={
            <>
              {t(`taskDetail.links.kinds.${kind}`)}
              <Chevron />
            </>
          }
        >
          {(close) => (
            <MenuGroup>
              {LINK_KINDS.map((k) => (
                <RadioItem
                  key={k}
                  checked={k === kind}
                  onSelect={() => {
                    close();
                    setKind(k);
                  }}
                >
                  {t(`taskDetail.links.kinds.${k}`)}
                </RadioItem>
              ))}
            </MenuGroup>
          )}
        </MenuButton>
        <label htmlFor={inputId} className="sr-only">
          {t("taskDetail.links.search")}
        </label>
        <input
          id={inputId}
          autoFocus
          value={query}
          placeholder={t("taskDetail.links.searchPlaceholder")}
          onChange={(e) => setQuery(e.target.value)}
          className={`${inputClass} h-8 py-0`}
        />
      </div>
      {q && (
        <ul aria-label={t("taskDetail.links.results")} className="flex flex-col">
          {results.length === 0 && (
            <li className="px-1.5 py-1 text-sm text-ink-muted">{t("taskDetail.links.noResults")}</li>
          )}
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onAdd(kind, r.id)}
                className="flex min-h-8 w-full min-w-0 items-baseline gap-2 rounded-md px-1.5 py-1 text-left hover:bg-ink/6"
              >
                <span className="num shrink-0 text-xs font-semibold text-ink-muted">{r.code}</span>
                <span className="min-w-0 truncate text-sm text-ink">{r.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end">
        <button type="button" className={smallSecondary} onClick={onCancel}>
          {t("taskDetail.cancel")}
        </button>
      </div>
    </div>
  );
}

function Attachments({ task, canEdit }: { task: Task; canEdit: boolean }) {
  const { t, i18n } = useTranslation();
  const change = useInlineUpdate();
  const [confirming, setConfirming] = useState<string | null>(null);
  const files = task.attachments;
  const next = FAKE_FILES.find((f) => !files.some((a) => a.name === f.name));
  const addFake = () => {
    if (!next) return;
    change(task, {
      attachments: [...files, { id: `att-${task.id}-${files.length + 1}-${next.name}`, ...next }],
    });
  };
  return (
    <Section
      title={t("taskDetail.attachments.title")}
      count={files.length}
      empty={files.length === 0 ? t("taskDetail.attachments.none") : undefined}
      action={
        canEdit &&
        next && (
          <button
            type="button"
            className={ghostButton}
            title={t("taskDetail.attachments.fake")}
            onClick={addFake}
          >
            <PlusIcon />
            {t("taskDetail.add")}
          </button>
        )
      }
    >
      {files.length > 0 && (
        <ul className="flex flex-col gap-1">
          {files.map((file) =>
            confirming === file.id ? (
              <li key={file.id}>
                <InlineConfirm
                  message={t("taskDetail.attachments.confirm", { name: file.name })}
                  confirm={t("taskDetail.attachments.remove")}
                  cancelLabel={t("taskDetail.cancel")}
                  onCancel={() => setConfirming(null)}
                  onConfirm={() => {
                    setConfirming(null);
                    change(task, { attachments: files.filter((a) => a.id !== file.id) });
                  }}
                />
              </li>
            ) : (
              <li key={file.id} className="group/file flex min-h-8 items-center gap-2">
                <FileIcon />
                <span className="min-w-0 flex-1 truncate text-sm text-ink" title={file.name}>
                  {file.name}
                </span>
                <span className="num shrink-0 text-xs text-ink-faint">
                  {formatBytes(file.sizeBytes, i18n.language)}
                </span>
                {canEdit && (
                  <button
                    type="button"
                    aria-label={t("taskDetail.attachments.removeLabel", { name: file.name })}
                    title={t("taskDetail.attachments.removeLabel", { name: file.name })}
                    onClick={() => setConfirming(file.id)}
                    className={`${ghostButton} w-7 justify-center px-0 opacity-60 group-hover/file:opacity-100 focus-visible:opacity-100`}
                  >
                    <CloseIcon size={12} />
                  </button>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </Section>
  );
}

function FileIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-ink-faint"
    >
      <path d="M4 1.75h5L12.25 5v9.25H4z" />
      <path d="M9 1.75V5h3.25" />
    </svg>
  );
}
