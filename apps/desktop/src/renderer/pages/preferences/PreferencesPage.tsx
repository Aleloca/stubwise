import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useMySecurity } from "../../data/queries";
import {
  PREFERENCE_SECTIONS,
  isPreferenceSection,
  type PreferenceSection,
} from "../../data/routes";
import { useViewer } from "../../data/viewer";
import { ONE_LINE, columnItemClass } from "../../layout/ProjectColumn";
import { AccountSection } from "./AccountSection";
import { ClaudeCodeSection } from "./ClaudeCodeSection";
import { LookSection } from "./LookSection";
import { NotificationsSection } from "./NotificationsSection";
import { SecuritySection } from "./SecuritySection";
import { TokensSection } from "./TokensSection";

// Le Preferenze (shape alerts.md, «Cornice delle Preferenze», e
// preferences-account.md): la colonna personale con le sei sezioni e la
// sezione aperta. Le sezioni sono le cose MIE: nessuna dipende da un permesso.

export { PREFERENCE_SECTIONS, isPreferenceSection, type PreferenceSection };

/**
 * «Off» accanto a Security quando il secondo fattore è spento [PR 6]: solo
 * testo, niente punto «ti aspetta» (non è una decisione).
 */
function SecurityOff() {
  const { t } = useTranslation();
  const security = useMySecurity();
  if (!security.data || security.data.on) return null;
  return (
    <span className="ml-auto shrink-0 pl-2 text-xs text-ink-faint">
      <span aria-hidden="true">{t("prefs.securityOff")}</span>
      <span className="sr-only">{t("prefs.securityOffLabel")}</span>
    </span>
  );
}

/** La colonna delle Preferenze: le sezioni, 32 px, senza titolo (il nome è l'h1). */
export function PreferencesColumn() {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t("prefs.columnLabel")}
      className="min-h-0 flex-1 overflow-y-auto px-2 pt-3 pb-2"
    >
      <ul className="flex flex-col gap-px">
        {PREFERENCE_SECTIONS.map((section) => (
          <li key={section}>
            <Link
              to="/preferences/$section"
              params={{ section }}
              style={{ whiteSpace: "nowrap" }}
              className={columnItemClass}
            >
              <span style={ONE_LINE} className="min-w-0">
                {t(`prefs.sections.${section}`)}
              </span>
              {section === "security" && <SecurityOff />}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Una sezione delle Preferenze; `?project=AUD` apre quel gruppo di
 * Notifiche. Le sezioni personali si rimontano al cambio di persona («vedi
 * come»): un valore mostrato una volta non passa da una persona all'altra.
 */
export function PreferencesPage({
  section,
  focusCode,
}: {
  section: PreferenceSection;
  focusCode?: string;
}) {
  const { viewer } = useViewer();
  const key = viewer.personId;
  switch (section) {
    case "notifications":
      // Notifiche non ha segreti, e al cambio di persona tiene ricerca e gruppi (alerts.md §5).
      return <NotificationsSection focusCode={focusCode} />;
    case "account":
      return <AccountSection key={key} />;
    case "security":
      return <SecuritySection key={key} />;
    case "tokens":
      return <TokensSection key={key} />;
    case "claude-code":
      return <ClaudeCodeSection key={key} />;
    case "look":
      return <LookSection key={key} />;
  }
}
