import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePeople, useSessionPersonId, useSetPrAnalysisOnly } from "../../data/queries";
import type { OpenPrView, ReleaseView } from "../../data/releases";
import { useToast } from "../../tasks-ui/Toast";
import { smallPrimary, smallSecondary } from "../task/parts";
import { ago, failedRun, mergedBy, prCode } from "./format";
import { PrGlyph, ReleaseGlyph } from "./glyphs";
import { FixDialog, useExplain } from "./FixDialog";

// «Needs attention» (shape releases.md [R 4]): il momento focale della
// sezione, l'unico riquadro con fondo, presente SOLO quando c'è un rilascio
// fallito senza task di riparazione o una mia PR con un commit di Claude.
// Una riga per caso, al massimo 3 e «and N more» che scorre a Releases.

const MAX = 3;

type Case = { kind: "release"; release: ReleaseView } | { kind: "pr"; pr: OpenPrView };

export function attentionCases(releases: ReleaseView[], prs: OpenPrView[], me: string): Case[] {
  const failed = releases
    .filter((r) => r.status.kind === "failed" && !r.fixTask?.open)
    .map((release): Case => ({ kind: "release", release }));
  const fixed = prs
    .filter((p) => p.authorId === me && p.prState.state === "corrected")
    .map((pr): Case => ({ kind: "pr", pr }));
  return [...failed, ...fixed];
}

function ReleaseCase({ release }: { release: ReleaseView }) {
  const { t, i18n } = useTranslation();
  const people = usePeople().data;
  const me = useSessionPersonId();
  const explain = useExplain();
  const [fixing, setFixing] = useState(false);
  const run = failedRun(release);
  const person = (id: string | null) =>
    id === me ? t("releases.you") : (people?.find((p) => p.id === id)?.name ?? null);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
      <ReleaseGlyph kind="failed" />
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="text-md text-ink [overflow-wrap:anywhere]">
          <Link
            to="/p/$code/releases/$release"
            params={{ code: release.projectCode, release: release.code }}
            className="num font-semibold underline-offset-4 hover:underline"
          >
            {release.code}
          </Link>{" "}
          {run?.failedStep
            ? t("releases.attention.failedAt", { step: run.failedStep, run: run.name })
            : t("releases.attention.failed")}
        </p>
        <p className="text-sm text-ink-muted">
          {t("releases.attention.mergedBy", {
            who: mergedBy(release, t, person),
            ago: ago(release.mergedAt, t, i18n.language),
          })}
        </p>
      </div>
      <span className="flex items-center gap-2">
        <button
          type="button"
          className={smallSecondary}
          disabled={explain.pending}
          onClick={() => void explain.run(release)}
        >
          {t("releases.explain.button")}
        </button>
        {release.canFix ? (
          <button type="button" className={smallPrimary} onClick={() => setFixing(true)}>
            {t("releases.fix.button")}
          </button>
        ) : (
          <Link
            to="/p/$code/releases/$release"
            params={{ code: release.projectCode, release: release.code }}
            className={smallSecondary}
          >
            {t("releases.open")}
          </Link>
        )}
      </span>
      {fixing && <FixDialog release={release} onClose={() => setFixing(false)} />}
    </li>
  );
}

function PrCase({ pr }: { pr: OpenPrView }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const set = useSetPrAnalysisOnly();
  const toast = useToast();
  const fixedCount = pr.corrections.filter((c) => c.state === "pushed").length;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
      <PrGlyph pr={pr} />
      <p className="min-w-0 flex-1 text-md text-ink [overflow-wrap:anywhere]">
        {t("releases.attention.claudePushed", {
          pr: prCode(pr),
          title: pr.title,
          count: fixedCount,
        })}
      </p>
      <span className="flex items-center gap-2">
        {pr.actions.analysisOnly && pr.analysisOnly === null && (
          <button
            type="button"
            className={smallSecondary}
            onClick={() =>
              set.mutate(
                { prId: pr.id, on: true },
                { onError: () => toast.error(t("releases.panel.analysisOnlyError")) },
              )
            }
          >
            {t("releases.attention.setAnalysisOnly")}
          </button>
        )}
        <button
          type="button"
          className={smallPrimary}
          onClick={() =>
            void navigate({
              to: ".",
              search: ((prev: Record<string, unknown>) => ({ ...prev, pr: pr.id })) as never,
            })
          }
        >
          {t("releases.open")}
        </button>
      </span>
    </li>
  );
}

export function NeedsAttention({ cases }: { cases: Case[] }) {
  const { t } = useTranslation();
  if (cases.length === 0) return null;
  const more = cases.length - MAX;
  return (
    <section
      aria-labelledby="needs-attention"
      className="flex flex-col rounded-lg border border-rule bg-ink/4 px-5 py-3"
    >
      <h2 id="needs-attention" className="heading-group pt-1 pb-1">
        {t("releases.groups.attention")}
      </h2>
      <ul className="flex flex-col divide-y divide-rule">
        {cases
          .slice(0, MAX)
          .map((c) =>
            c.kind === "release" ? (
              <ReleaseCase key={c.release.id} release={c.release} />
            ) : (
              <PrCase key={c.pr.id} pr={c.pr} />
            ),
          )}
      </ul>
      {more > 0 && (
        <button
          type="button"
          onClick={() =>
            document.getElementById("releases-part")?.scrollIntoView?.({ block: "start" })
          }
          className="self-start rounded-sm py-1 text-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline"
        >
          {t("releases.attention.more", { count: more })}
        </button>
      )}
    </section>
  );
}
