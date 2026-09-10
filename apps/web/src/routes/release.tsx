import { ApiError } from "@stubwise/api-client";
import type { ReleaseQueueItem } from "@stubwise/shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { releasePullRequest } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { releaseQueueQueryOptions } from "../lib/queries";

/**
 * Coda di rilascio (fase 8, Task 9-10): TUTTE le PR aperte sui repository
 * collegati, di qualunque origine — la review le tratta già tutte allo
 * stesso modo (design §4), quindi nasconderne metà renderebbe la pagina
 * bugiarda. Una pagina sola, per il maintainer: la rotta server è
 * `requireAdmin` su lista E azione (a differenza degli ambienti, dove solo
 * le scritture lo erano) — un member non arriva qui (la voce di nav è
 * `memberVisible: false`), e se ci arrivasse per URL diretto la richiesta
 * risponderebbe 403.
 *
 * **Stubwise non esegue né rilascia ambienti** — l'unica azione che questa
 * pagina offre è il MERGE esplicito, mai un deploy. Check del provider e
 * test interno restano colonne SEPARATE, mai fuse in un semaforo solo
 * (design §4): il test interno è ciò che la pipeline ha eseguito nel suo
 * container PRIMA di aprire la PR, i check sono ciò che il provider dice
 * ADESSO — due fatti diversi, letti da due posti diversi.
 */
export function ReleaseQueuePage() {
  const { t } = useTranslation();
  const { data } = useSuspenseQuery(releaseQueueQueryOptions);

  return (
    <div className="page mx-auto w-full max-w-5xl">
      <header>
        <h1 className="font-mono text-lg font-semibold tracking-[0.02em] text-fg uppercase">
          {t("release:title")}
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-fg-muted">{t("release:subtitle")}</p>
      </header>

      {data.items.length === 0 ? (
        <div className="mt-6 rounded-sm border border-dashed border-line-strong px-4 py-12 text-center">
          <p className="font-mono text-[12px] tracking-[0.14em] text-fg-faint uppercase">
            {t("release:empty")}
          </p>
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-line rounded-sm border border-line bg-ink-900">
          {data.items.map((item) => (
            <ReleaseRow key={`${item.ticketId}:${item.repositoryId}`} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ReleaseRow({ item }: { item: ReleaseQueueItem }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const release = useMutation({
    mutationFn: () => releasePullRequest(item.ticketId, item.repositoryId),
    onSuccess: async () => {
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: releaseQueueQueryOptions.queryKey });
    },
  });

  const checksLabel =
    item.checks.status === "no_checks"
      ? t("release:checks.noChecks")
      : t(`release:checks.${item.checks.status}`);

  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              to="/tickets/$id"
              params={{ id: item.ticketId }}
              className="font-mono text-[13px] font-medium text-fg hover:text-signal"
            >
              #{item.ticketNumber} {item.ticketTitle}
            </Link>
            <span className="font-mono text-[11px] text-fg-faint">
              {item.projectName} / {item.repositoryName}
            </span>
          </div>
          <a
            href={item.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block font-mono text-[11px] text-signal underline-offset-2 hover:underline"
          >
            {item.branch}
          </a>
          <time
            className="ml-2 font-mono text-[11px] text-fg-faint"
            dateTime={item.createdAt}
            title={item.createdAt}
          >
            {formatRelativeTime(item.createdAt)}
          </time>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={release.isPending}
              className="inline-flex min-h-9 items-center rounded-sm bg-signal px-3 font-mono text-[11px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("release:release")}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => release.mutate()}
                disabled={release.isPending}
                className="inline-flex min-h-9 items-center rounded-sm bg-signal px-3 font-mono text-[11px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:opacity-50"
              >
                {release.isPending ? t("release:releasing") : t("release:confirm")}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={release.isPending}
                className="inline-flex min-h-9 items-center rounded-sm px-3 font-mono text-[11px] tracking-[0.08em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
              >
                {t("common:cancel")}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[11px]">
        <ColumnBadge
          label={t("release:columns.review")}
          value={item.reviewVerdict ? t(`release:review.${item.reviewVerdict}`) : t("release:review.none")}
          tone={item.reviewVerdict === "approve" ? "good" : item.reviewVerdict === "request_changes" ? "bad" : "neutral"}
        />
        <ColumnBadge
          label={t("release:columns.checks")}
          value={checksLabel}
          tone={item.checks.status === "success" ? "good" : item.checks.status === "failure" ? "bad" : "neutral"}
        />
        <ColumnBadge
          label={t("release:columns.testStatus")}
          value={item.testStatus ? t(`release:testStatus.${item.testStatus}`) : t("release:testStatus.none")}
          tone={item.testStatus === "passed" ? "good" : item.testStatus === "failed" ? "bad" : "neutral"}
        />
        <ColumnBadge
          label={t("release:columns.risk")}
          value={item.risk ? t(`release:risk.${item.risk}`) : t("release:risk.none")}
          tone={item.risk === "low" ? "good" : item.risk === "high" ? "bad" : "neutral"}
          title={item.riskReason ?? undefined}
        />
        {item.deployedOn.length > 0 && (
          <ColumnBadge
            label={t("release:columns.deployedOn")}
            value={item.deployedOn.join(", ")}
            tone="good"
          />
        )}
      </div>

      {item.reviewSummary && (
        <p className="mt-2 border-l-2 border-line-strong pl-3 text-sm text-fg-muted">{item.reviewSummary}</p>
      )}

      {release.isError && (
        <p role="alert" className="mt-2 font-mono text-[11px] text-danger">
          {releaseErrorMessage(release.error, t)}
        </p>
      )}
    </li>
  );
}

function releaseErrorMessage(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "already_closed":
        return t("release:errors.alreadyClosed");
      case "checks_failed":
        return t("release:errors.checksFailed");
      case "not_mergeable":
        return t("release:errors.notMergeable");
      case "merge_forbidden":
        return t("release:errors.mergeForbidden");
      case "not_found":
        return t("release:errors.notFound");
      default:
        return t("release:errors.generic");
    }
  }
  return t("release:errors.generic");
}

function ColumnBadge({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone: "good" | "bad" | "neutral";
  title?: string;
}) {
  const toneClass =
    tone === "good"
      ? "border-signal-dim/40 text-signal"
      : tone === "bad"
        ? "border-danger/30 text-danger"
        : "border-line-strong text-fg-muted";
  return (
    <span className={`rounded-sm border px-1.5 py-0.5 tracking-[0.06em] uppercase ${toneClass}`} title={title}>
      {label}: {value}
    </span>
  );
}
