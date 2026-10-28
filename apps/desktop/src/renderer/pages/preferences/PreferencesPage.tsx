import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ONE_LINE, columnItemClass } from "../../layout/ProjectColumn";
import { Placeholder } from "../Placeholder";
import { NotificationsSection } from "./NotificationsSection";

// Le Preferenze (shape alerts.md, «Cornice delle Preferenze»): la colonna
// personale con le sezioni e, per ora, la sola sezione Notifiche costruita.
// Tema e lingua restano nel menu del profilo: la colonna non li duplica.

export const PREFERENCE_SECTIONS = ["notifications", "account", "security", "claude-code"] as const;
export type PreferenceSection = (typeof PREFERENCE_SECTIONS)[number];

export const isPreferenceSection = (value: string): value is PreferenceSection =>
  (PREFERENCE_SECTIONS as readonly string[]).includes(value);

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
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Una sezione delle Preferenze: Notifiche è viva (`?project=AUD` apre quel
 * gruppo); le altre portano al segnaposto col loro h1 [A 2].
 */
export function PreferencesPage({
  section,
  focusCode,
}: {
  section: PreferenceSection;
  focusCode?: string;
}) {
  if (section === "notifications") return <NotificationsSection focusCode={focusCode} />;
  return <Placeholder titleKey={`prefs.sections.${section}`} bodyKey="prefs.later" />;
}
