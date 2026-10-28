import { useTranslation } from "react-i18next";
import type { OpenPrView, ReleaseView } from "../../data/releases";
import { Glyph } from "../automations/glyphs";
import { prStateWord } from "./format";

// I glifi della sezione Releases (shape releases.md §5): sempre accanto alla
// parola, mai da soli; il colore solo dove è uno stato (positive, warning,
// critical), «Claude al lavoro» è l'anello tratteggiato d'inchiostro.

type PrKind = OpenPrView["prState"]["state"];

function ClaudeRing() {
  return (
    <Glyph className="text-ink">
      <circle cx="8" cy="8" r="5" strokeDasharray="2.2 2" />
    </Glyph>
  );
}

const Check = ({ className }: { className: string }) => (
  <Glyph className={className}>
    <path d="m4 8.5 2.5 2.5L12 5.5" />
  </Glyph>
);

const Triangle = () => (
  <Glyph className="text-warning">
    <path d="M8 3 13.5 12.5h-11z" />
    <path d="M8 7v2.5M8 11h.01" />
  </Glyph>
);

export function PrGlyph({ pr }: { pr: OpenPrView }) {
  const kind: PrKind = pr.prState.state;
  switch (kind) {
    case "analyzing":
    case "correcting":
      return <ClaudeRing />;
    case "clean":
      return <Check className="text-positive" />;
    case "issues":
      return <Triangle />;
    case "corrected":
      return <Check className="text-ink" />;
    case "discarded":
      return (
        <Glyph className="text-ink-faint">
          <path d="M5 11.5 11 4.5" />
        </Glyph>
      );
    case "capped":
      return (
        <Glyph className="text-ink-muted">
          <path d="M6 4.5v7M10 4.5v7" />
        </Glyph>
      );
    case "analysis_only":
      return (
        <Glyph className="text-ink-muted">
          <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" />
          <circle cx="8" cy="8" r="1.6" />
        </Glyph>
      );
    case "analysis_off":
      return (
        <Glyph className="text-ink-faint">
          <circle cx="8" cy="8" r="3.5" />
        </Glyph>
      );
    case "not_fixable":
      return (pr.analysis?.issues.length ?? 0) > 0 ? (
        <Triangle />
      ) : (
        <Check className="text-positive" />
      );
  }
}

/** Glifo + parola di stato di una PR (la parola in inchiostro, 600). */
export function PrStateWord({ pr }: { pr: OpenPrView }) {
  const { t } = useTranslation();
  return (
    <span data-pr-state={pr.prState.state} className="inline-flex shrink-0 items-center gap-1.5">
      <PrGlyph pr={pr} />
      <span className="font-semibold text-ink">{prStateWord(pr, t)}</span>
    </span>
  );
}

export function ReleaseGlyph({ kind }: { kind: ReleaseView["status"]["kind"] }) {
  switch (kind) {
    case "running":
      return (
        <Glyph className="text-ink">
          <path d="M6 4.5 11 8l-5 3.5z" fill="currentColor" />
        </Glyph>
      );
    case "succeeded":
    case "in_production":
      return <Check className="text-positive" />;
    case "failed":
      return (
        <Glyph className="text-critical">
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5v3.5M8 10.75h.01" />
        </Glyph>
      );
    case "not_in_production":
      return (
        <Glyph className="text-ink-muted">
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5v3l2 1.5" />
        </Glyph>
      );
    case "unavailable":
      return (
        <Glyph className="text-ink-faint">
          <circle cx="8" cy="8" r="4" />
        </Glyph>
      );
  }
}

/** Glifo + parola di stato di un rilascio. */
export function ReleaseStatusWord({ release }: { release: ReleaseView }) {
  const { t } = useTranslation();
  const kind = release.status.kind;
  return (
    <span
      data-release-status={kind}
      className="inline-flex min-w-0 items-center gap-1.5 text-sm text-ink"
    >
      <ReleaseGlyph kind={kind} />
      <span className="min-w-0">{t(`releases.status.${kind}`)}</span>
    </span>
  );
}

/** «↗» dei link esterni, disegnato. */
export function ExternalGlyph() {
  return (
    <Glyph size={12} className="text-ink-muted">
      <path d="M6 4h6v6M12 4 5 11" />
    </Glyph>
  );
}
