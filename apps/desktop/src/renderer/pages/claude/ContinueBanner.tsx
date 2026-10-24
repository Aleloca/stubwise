import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { ConversationDetail } from "../../data/types";
import { usePersonName } from "./conversation/parts";

/**
 * La fascia sopra la casella in una conversazione pubblica di un altro:
 * scrivere qui non tocca la sua, apre una conversazione propria e privata,
 * in cui Claude agisce come chi scrive.
 */
export function ContinueBanner({ compact }: { compact: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={compact ? "px-4 pt-2" : "px-8 pt-2"}>
      <p
        data-continue-banner
        className="mx-auto flex w-full max-w-[720px] items-start gap-2 text-sm text-ink-muted"
      >
        <BranchGlyph />
        <span className="min-w-0">{t("claude.destination.continue.banner")}</span>
      </p>
    </div>
  );
}

/**
 * In testa a una continuazione: da quale conversazione parte (un link, con
 * chi l'ha aperta), oppure che l'originale non si può più leggere (R-E7).
 */
export function ContinuesFromLine({
  origin,
}: {
  origin: NonNullable<ConversationDetail["continuesFrom"]>;
}) {
  const { t } = useTranslation();
  const owner = usePersonName(origin.ownerId);
  if (!origin.available) {
    return (
      <p className="flex items-center gap-2 text-sm text-ink-muted" data-origin-gone>
        <BranchGlyph />
        {t("claude.destination.continue.gone")}
      </p>
    );
  }
  return (
    <p className="flex min-w-0 items-center gap-2 text-sm text-ink-muted">
      <BranchGlyph />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {t("claude.destination.continue.from")}{" "}
        <Link
          to="/claude/$id"
          params={{ id: origin.id }}
          className="font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
        >
          {t("claude.destination.continue.quoted", { title: origin.title })}
        </Link>
        {owner && (
          <>
            {" · "}
            {owner}
          </>
        )}
      </span>
    </p>
  );
}

/** Un ramo che si stacca: la conversazione che parte da un'altra. */
function BranchGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="mt-[3px] shrink-0 self-start"
    >
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 2.5-2 3.5-5.5 4.2" />
    </svg>
  );
}
