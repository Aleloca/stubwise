import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMergeRequest, useRequests } from "../../data/queries";
import type { ProjectRequest } from "../../data/types";
import { findSimilarRequest, relatedRequests } from "../../domain/requests";
import { Dialog, inputClass } from "../../tasks-ui/Dialog";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { RequestStatusLabel } from "./marks";

/**
 * Le richieste in cui si può fondere `request`: dello stesso progetto, non
 * archiviate né già fuse. Prima le simili (quelle legate e quella che
 * l'intake finto sceglierebbe), poi le altre dalla più recente.
 */
export function mergeCandidates(
  request: ProjectRequest,
  all: readonly ProjectRequest[],
): { request: ProjectRequest; similar: boolean }[] {
  const eligible = all.filter(
    (r) =>
      r.id !== request.id &&
      r.projectId === request.projectId &&
      r.status !== "archived" &&
      r.mergedIntoId === null,
  );
  const similarIds = new Set(relatedRequests(request, eligible).map((r) => r.id));
  const guess = findSimilarRequest(request.title, request.projectId, eligible, request.id);
  if (guess) similarIds.add(guess.id);
  const recent = [...eligible].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return [
    ...recent.filter((r) => similarIds.has(r.id)).map((r) => ({ request: r, similar: true })),
    ...recent.filter((r) => !similarIds.has(r.id)).map((r) => ({ request: r, similar: false })),
  ];
}

/**
 * «Merge into…»: si cerca fra le richieste del progetto (le simili in
 * cima, segnate) e se ne sceglie una. Chi aveva chiesto questa segue
 * l'altra; questa si archivia e lo dice («Merged into …»).
 */
export function MergeDialog({
  request,
  projectName,
  onMerged,
  onClose,
}: {
  request: ProjectRequest;
  projectName: string;
  onMerged: (into: ProjectRequest) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const all = useRequests(request.projectId).data;
  const merge = useMergeRequest();
  const [text, setText] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [failed, setFailed] = useState(false);
  const searchId = useId();
  const name = useId();

  const candidates = useMemo(() => (all ? mergeCandidates(request, all) : []), [all, request]);
  const q = text.trim().toLowerCase();
  const shown = q ? candidates.filter((c) => c.request.title.toLowerCase().includes(q)) : candidates;
  const chosen = candidates.find((c) => c.request.id === target)?.request;

  const submit = () => {
    setTried(true);
    if (!chosen) return;
    setFailed(false);
    merge.mutate(
      { id: request.id, intoId: chosen.id },
      { onSuccess: () => onMerged(chosen), onError: () => setFailed(true) },
    );
  };

  return (
    <Dialog
      title={t("requests.merge.title")}
      description={t("requests.merge.description", { title: request.title })}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("taskDetail.cancel")}
          </button>
          <button
            type="submit"
            form="merge-request"
            className={primaryButton}
            disabled={merge.isPending || candidates.length === 0}
          >
            {t("requests.merge.submit")}
          </button>
        </>
      }
    >
      <form
        id="merge-request"
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor={searchId} className="sr-only">
          {t("requests.merge.search")}
        </label>
        <input
          id={searchId}
          type="search"
          data-autofocus
          value={text}
          placeholder={t("requests.merge.search")}
          onChange={(e) => setText(e.target.value)}
          className={inputClass}
        />
        <fieldset className="flex min-w-0 flex-col">
          <legend className="pt-1 pb-1.5 text-sm font-medium text-ink">
            {t("requests.merge.list", { project: projectName })}
          </legend>
          <div className="max-h-72 overflow-y-auto rounded-md border border-rule">
            {!all ? (
              <p role="status" className="px-3 py-3 text-sm text-ink-muted">
                {t("taskUi.states.loading")}
              </p>
            ) : candidates.length === 0 ? (
              <p className="px-3 py-3 text-sm text-ink-muted">{t("requests.merge.none")}</p>
            ) : shown.length === 0 ? (
              <p className="px-3 py-3 text-sm text-ink-muted">{t("requests.merge.noMatch")}</p>
            ) : (
              shown.map(({ request: r, similar }) => (
                <label
                  key={r.id}
                  data-merge-candidate={r.id}
                  className="flex min-h-10 cursor-default items-center gap-2.5 border-b border-rule px-3 py-1.5 last:border-b-0 hover:bg-ink/4 has-checked:bg-ink/8"
                >
                  <input
                    type="radio"
                    name={name}
                    value={r.id}
                    checked={target === r.id}
                    onChange={() => setTarget(r.id)}
                    className="size-3.5 shrink-0 accent-ink"
                  />
                  <span className="min-w-0 flex-1 truncate text-md text-ink" title={r.title}>
                    {r.title}
                  </span>
                  {similar && (
                    <span className="shrink-0 rounded-[4px] border border-rule-strong px-1.5 text-xs font-medium text-ink">
                      {t("requests.merge.similarTag")}
                    </span>
                  )}
                  <span className="w-[132px] shrink-0">
                    <RequestStatusLabel status={r.status} />
                  </span>
                </label>
              ))
            )}
          </div>
        </fieldset>
        {tried && !chosen && candidates.length > 0 && (
          <span className="text-xs text-critical">{t("requests.merge.choose")}</span>
        )}
        {failed && (
          <p role="alert" className="rounded-md bg-critical/10 px-3 py-2 text-sm text-ink">
            {t("requests.merge.failed")}
          </p>
        )}
      </form>
    </Dialog>
  );
}
