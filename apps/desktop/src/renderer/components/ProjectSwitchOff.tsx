import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

// Le impostazioni di progetto dove si sentono (area 9c, Task 6, shape
// project-effects.md [PX 1]): uno spento si dice nel posto in cui si
// sarebbe promesso il contrario, con una riga sola ○ in `ink-muted` e il
// link a «Settings → Automations» del progetto, che ogni membro legge.
// Nessun «Who?»: non è un permesso che manca, è una scelta. Nessun colore di
// stato: uno spento per scelta non è un guasto.

/** Il link a Progetto → Settings → Automations (il fuoco va all'h1 della sezione). */
export function AutomationsSettingsLink({ projectCode }: { projectCode: string }) {
  const { t } = useTranslation();
  return (
    <Link
      to="/p/$code/settings/$section"
      params={{ code: projectCode, section: "automations" }}
      className="rounded-sm whitespace-nowrap text-ink underline decoration-ink/30 underline-offset-4 transition-colors duration-[var(--duration-fast)] ease-out hover:decoration-ink"
    >
      {t("projectEffects.settingsLink")}
    </Link>
  );
}

/**
 * «○ The weekly brief is off for MKX. Settings → Automations». `size` 13px
 * (`sm`) al posto di una promessa, 12px (`xs`) sotto un contenuto già
 * scritto che resta leggibile.
 */
export function SwitchOffLine({
  projectCode,
  children,
  size = "sm",
  kind,
}: {
  projectCode: string;
  children: ReactNode;
  size?: "sm" | "xs";
  kind: string;
}) {
  return (
    <p
      data-switch-off={kind}
      className={`flex gap-2 text-ink-muted ${size === "sm" ? "text-sm" : "text-xs"}`}
    >
      <span aria-hidden="true" className="w-3 shrink-0 text-center">
        ○
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {children} <AutomationsSettingsLink projectCode={projectCode} />
      </span>
    </p>
  );
}
