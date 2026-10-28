import { useNavigate } from "@tanstack/react-router";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { OpenPrView } from "../../data/releases";
import { Avatar } from "../../tasks-ui/PersonChip";
import { usePeople } from "../../data/queries";
import { checksWord, notReadyReason, prCode, prProse, prStateWord, riskWord } from "./format";
import { PrStateWord } from "./glyphs";
import { MergeButton, MergeExpansion, useMergeFlow, type MergeError } from "./MergeConfirm";

// Una riga di PR (shape releases.md §6, «Riga»): due linee, tutta
// cliccabile → pannello (`?pr=`). Stessa forma per le PR di Stubwise e dei
// colleghi: cambiano solo l'autore e, se c'è, la task collegata. Nessun
// «Adopt», nessun altro segno di differenza (anti-obiettivo dello shape).
// Nel gruppo «Pronte», «Release» all'estrema destra con il due tempi.

export function PrRow({
  pr,
  projectCode,
  ready,
  canMerge,
  onStaging,
  onMergeError,
}: {
  pr: OpenPrView;
  projectCode: string;
  ready: boolean;
  canMerge: boolean;
  /** Il commit della PR gira su un ambiente di staging ([R 8]). */
  onStaging?: boolean;
  onMergeError?: (prId: string, error: MergeError | null) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const people = usePeople().data;
  const author = pr.authorId ? people?.find((p) => p.id === pr.authorId) : undefined;
  const flow = useMergeFlow(pr, projectCode, (e) => onMergeError?.(pr.id, e));

  const open = () =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, pr: pr.id }),
    } as never);

  const reason = ready ? null : notReadyReason(pr, t);
  const risk = riskWord(pr, t);
  const prose = prProse(pr, t);
  const facts = [
    reason,
    risk,
    prose,
    reason ? null : checksWord(pr, t),
    onStaging ? t("releases.prLine.onStaging") : null,
  ].filter((x): x is string => !!x);
  const authorName = author?.name ?? pr.authorName;
  const label = [
    prCode(pr),
    pr.title,
    t("releases.pr.by", { name: authorName }),
    prStateWord(pr, t),
    ...facts,
  ].join(", ");

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };

  return (
    <li data-pr-row={pr.id} className="border-b border-rule">
      <div className="flex min-h-14 items-center gap-3 rounded-md px-3 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 has-[[data-pr-open]:focus-visible]:bg-ink/6">
        <div
          role="link"
          tabIndex={0}
          data-pr-open
          aria-label={label}
          onClick={open}
          onKeyDown={onKeyDown}
          className="flex min-w-0 flex-1 cursor-pointer flex-col justify-center gap-0.5 self-stretch py-2 outline-none"
        >
          <span className="flex min-w-0 items-baseline gap-3">
            <span className="num shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
              {prCode(pr)}
            </span>
            <span className="min-w-0 truncate text-md text-ink" title={pr.title}>
              {pr.title}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-2 text-sm text-ink-muted">
              {author || pr.origin === "stubwise" ? (
                <Avatar person={author ?? people?.find((p) => p.isClaude)} />
              ) : (
                <span
                  aria-hidden="true"
                  className="grid size-[22px] shrink-0 place-items-center rounded-full bg-ink/10 text-xs font-semibold text-ink"
                >
                  {initialsOf(pr.authorName)}
                </span>
              )}
              <span className="max-w-[18ch] truncate @max-[560px]:hidden">{authorName}</span>
              {pr.fromFork && <span className="@max-[560px]:hidden">{t("releases.pr.fork")}</span>}
              {pr.taskCode && (
                <span className="num text-xs font-semibold text-ink">{pr.taskCode}</span>
              )}
            </span>
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm text-ink-muted">
            <PrStateWord pr={pr} />
            {facts.map((f, i) => (
              <span key={i} className={i > 1 ? "@max-[560px]:hidden" : undefined}>
                <span aria-hidden="true">· </span>
                <span
                  className={
                    f === risk && pr.analysis?.risk === "high" ? "text-critical" : undefined
                  }
                >
                  {f}
                </span>
              </span>
            ))}
          </span>
        </div>
        {ready && canMerge && <MergeButton pr={pr} flow={flow} />}
      </div>
      <MergeExpansion pr={pr} flow={flow} projectCode={projectCode} />
    </li>
  );
}

/** Le iniziali di un'identità git non collegata («ext-contrib» → «EX»). */
function initialsOf(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : name.slice(0, 2);
  return letters.toUpperCase();
}
