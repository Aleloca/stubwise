import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useAutomationOrigin } from "../../data/queries";
import type { AutomationRef } from "../../data/types";

const linkClass =
  "rounded-sm text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink";

/**
 * «Created by automation AUD-A1 Richiesta dati al cliente · run #12» su
 * una task o un traguardo (shape automations.md §6): codice e nome portano
 * all'automazione, «#12» alla riga del registro che l'ha creato. Se chi
 * guarda non vede l'automazione: «Created by an automation», senza nomi né
 * link [A 24].
 */
export function AutomationOriginLine({
  automationRef,
  createdCode,
  kind,
  className = "text-sm text-ink-muted",
}: {
  automationRef: AutomationRef;
  /** Una task o un traguardo: in italiano «Creata» o «Creato». */
  kind: "task" | "milestone";
  /** Il codice della task o l'id del traguardo (trova la riga del registro). */
  createdCode: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const origin = useAutomationOrigin(automationRef, createdCode).data;
  if (!origin) return null;
  if (!origin.visible) {
    return (
      <p data-automation-origin="hidden" className={className}>
        {t(
          kind === "task" ? "automations.origin.hiddenTask" : "automations.origin.hiddenMilestone",
        )}
      </p>
    );
  }
  return (
    <p data-automation-origin={origin.code} className={`${className} [overflow-wrap:anywhere]`}>
      {t(kind === "task" ? "automations.origin.byTask" : "automations.origin.byMilestone")}{" "}
      <Link to="/automations/$code" params={{ code: origin.code }} className={linkClass}>
        <span className="num font-semibold">{origin.code}</span> {origin.name}
      </Link>
      <span aria-hidden="true" className="text-ink-faint">
        {" · "}
      </span>
      <Link
        to="/automations/$code/runs/$n"
        params={{ code: origin.code, n: String(origin.n) }}
        search={(origin.entry ? { entry: origin.entry } : {}) as never}
        className={linkClass}
      >
        {t("automations.origin.run", { n: origin.n })}
      </Link>
    </p>
  );
}
