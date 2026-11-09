import { useTranslation } from "react-i18next";
import { LanguageChoice, ThemeChoice } from "../../layout/LookControls";
import { PrefsPage } from "./parts";

// Preferenze → Language & theme (shape preferences-account.md): i due
// gruppi del menu del profilo, gli STESSI componenti (`LookControls`). Si
// applicano subito; sotto, dove altro si trovano.

const groupLabel = "text-xl font-semibold text-ink pb-2";

export function LookSection() {
  const { t } = useTranslation();
  return (
    <PrefsPage title={t("prefs.sections.look")} intro={t("prefs.look.intro")}>
      <div className="mt-6 grid max-w-[480px] gap-x-12 border-t border-rule pt-3 sm:grid-cols-2">
        <div className="-mx-2">
          <LanguageChoice labelClassName={`${groupLabel} px-2`} />
        </div>
        <div className="-mx-2">
          <ThemeChoice labelClassName={`${groupLabel} px-2`} />
        </div>
      </div>
      <p className="mt-4 text-xs text-ink-faint">{t("prefs.look.alsoIn")}</p>
    </PrefsPage>
  );
}
