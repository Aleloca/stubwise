import { useTranslation } from "react-i18next";
import { useCodeCitations } from "../../data/queries";
import type { MailProposalView } from "../../data/types";
import { routeOfCode } from "../claude/conversation/ProposalCard";
import { whenWithTime } from "./format";
import { AlertGlyph } from "./glyphs";
import { reasonKey } from "./proposalText";

/** I codici nati, apribili se li vedo (con il nome), altrimenti solo il codice in `ink-faint` (R-E9). */
function Codes({ codes }: { codes: readonly string[] }) {
  const visible = useCodeCitations(codes).data;
  return (
    <>
      {codes.map((code) => {
        const seen = visible?.find((c) => c.code === code && c.visible);
        return (
          <span key={code}>
            {" · "}
            {seen ? (
              <a
                href={routeOfCode(code)}
                className="rounded-sm underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
              >
                <span className="num font-semibold text-ink">{code}</span>
                {seen.name && <span className="text-ink"> {seen.name}</span>}
              </a>
            ) : (
              <span className="num font-semibold text-ink-faint">{code}</span>
            )}
          </span>
        );
      })}
    </>
  );
}

/** La riga d'esito: chi ha deciso, quando, cosa è nato (o perché non è riuscita). */
export function Outcome({
  view,
  code,
  ability,
  me,
  added,
}: {
  view: MailProposalView;
  code: string;
  ability: string;
  me: string;
  added: readonly string[];
}) {
  const { t, i18n } = useTranslation();
  const p = view.proposal;
  const mine = view.decidedBy?.personId === me;
  const name = view.decidedBy?.name ?? "";
  const when = p.decidedAt ? ` · ${whenWithTime(p.decidedAt, i18n.language)}` : "";
  switch (p.status) {
    case "confirmed":
      return (
        <p role="status" className="text-sm text-ink [overflow-wrap:anywhere]">
          <span className="font-semibold">
            {mine ? t("mail.outcome.confirmedByYou") : t("mail.outcome.confirmedBy", { name })}
          </span>
          <span className="num text-ink-muted">{when}</span>
          <Codes codes={p.resultCodes} />
          {p.confirmedActions && (
            <span className="text-ink-muted">
              {" · "}
              {t("mail.outcome.partial", { n: p.confirmedActions.length, count: p.actions.length })}
            </span>
          )}
          {added.map((who) => (
            <span key={who} className="text-ink-muted">
              {" · "}
              {t("mail.outcome.added", { name: who, code })}
            </span>
          ))}
        </p>
      );
    case "ignored":
      return (
        <p role="status" className="text-sm text-ink-muted">
          {mine ? t("mail.outcome.ignoredByYou") : t("mail.outcome.ignoredBy", { name })}
          <span className="num">{when}</span>
        </p>
      );
    case "handed":
      return (
        <p role="status" className="text-sm text-ink-muted">
          {mine ? t("mail.outcome.handedByYou") : t("mail.outcome.handedBy", { name })}
          <span className="num">{when}</span>
          {" · "}
          {t("mail.outcome.waitingFor", { ability, code })}
        </p>
      );
    case "failed":
      return (
        <p role="status" className="flex items-start gap-1.5 text-sm text-critical">
          <span className="mt-0.5">
            <AlertGlyph size={14} />
          </span>
          {t("mail.outcome.failed", { reason: t(`mail.outcome.reasons.${reasonKey(p.error)}`, { ability, code }) })}
        </p>
      );
    default:
      return null;
  }
}
