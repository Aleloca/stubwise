import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { setLanguage, type Language } from "../i18n";
import { useTheme } from "../theme/ThemeProvider";
import type { ThemePreference } from "../theme/theme";

// Tema e lingua: gli STESSI controlli nel menu del profilo e in Preferenze →
// Language & theme (shape preferences-account.md). Uno solo scrive tema e
// lingua (`useTheme`, `setLanguage`): la pagina non ne tiene una copia.

const THEMES: ThemePreference[] = ["system", "light", "dark"];
// Ogni lingua si presenta col proprio nome, in entrambe le interfacce.
const LANGUAGES: { id: Language; key: string }[] = [
  { id: "en", key: "rail.languages.en" },
  { id: "it", key: "rail.languages.it" },
];

/** Un gruppo di scelte a radio, con il titolo di gruppo sopra. */
export function RadioGroup<T extends string>({
  label,
  name,
  value,
  options,
  onChange,
  labelClassName = "heading-group px-2 pb-1",
}: {
  label: string;
  name: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  labelClassName?: string;
}) {
  const labelId = useId();
  return (
    <div role="radiogroup" aria-labelledby={labelId} className="flex flex-col gap-0.5 py-2">
      <div id={labelId} className={labelClassName}>
        {label}
      </div>
      {options.map((o) => (
        <label
          key={o.value}
          className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 text-sm text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 has-[:checked]:bg-ink/8"
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={o.value === value}
            onChange={() => onChange(o.value)}
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/** System · Light · Dark: si applica subito. */
export function ThemeChoice({ labelClassName }: { labelClassName?: string }) {
  const { t } = useTranslation();
  const { preference, setPreference } = useTheme();
  const name = useId();
  return (
    <RadioGroup
      label={t("rail.theme")}
      name={`${name}-theme`}
      value={preference}
      options={THEMES.map((id) => ({ value: id, label: t(`rail.themes.${id}`) }))}
      onChange={setPreference}
      labelClassName={labelClassName}
    />
  );
}

/** English · Italiano, ognuna nel suo nome: si applica subito. */
export function LanguageChoice({ labelClassName }: { labelClassName?: string }) {
  const { t, i18n } = useTranslation();
  const name = useId();
  return (
    <RadioGroup
      label={t("rail.language")}
      name={`${name}-language`}
      value={(i18n.resolvedLanguage ?? "en") as Language}
      options={LANGUAGES.map((l) => ({ value: l.id, label: t(l.key) }))}
      onChange={setLanguage}
      labelClassName={labelClassName}
    />
  );
}
