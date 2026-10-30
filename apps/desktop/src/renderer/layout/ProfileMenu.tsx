import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useDepartments,
  useLogout,
  usePeople,
  useResetPrototype,
  useResetToEmptyInstance,
} from "../data/queries";
import { VIEW_AS_PERSONAS, canSeeAdmin, useViewer } from "../data/viewer";
import { setLanguage, type Language } from "../i18n";
import { useTheme } from "../theme/ThemeProvider";
import type { ThemePreference } from "../theme/theme";
import { openGoogleAccount } from "../pages/drive/GoogleAccountCard";
import { useToast } from "../tasks-ui/Toast";
import { PrototypeBox } from "../pages/automations/shared";
import { Tooltip } from "./Tooltip";

const THEMES: ThemePreference[] = ["system", "light", "dark"];
// Ogni lingua si presenta col proprio nome, in entrambe le interfacce.
const LANGUAGES: { id: Language; key: string }[] = [
  { id: "en", key: "rail.languages.en" },
  { id: "it", key: "rail.languages.it" },
];

function RadioGroup<T extends string>({
  label,
  name,
  value,
  options,
  onChange,
}: {
  label: string;
  name: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
}) {
  const labelId = useId();
  return (
    <div role="radiogroup" aria-labelledby={labelId} className="flex flex-col gap-0.5 py-2">
      <div id={labelId} className="heading-group px-2 pb-1">
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

/** Quanto resta armata la conferma a due tempi («Reset — sure?»). */
const ARMED_MS = 4000;

/**
 * Un reset del prototipo con la conferma a due tempi in posto: il primo clic
 * arma il bottone («Reset — sure?») per 4 secondi, il secondo lo esegue.
 */
function ArmedReset({
  label,
  hint,
  onConfirm,
  disabled,
}: {
  label: string;
  hint: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [armed, setArmed] = useState(false);
  const hintId = useId();
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), ARMED_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        disabled={disabled}
        aria-describedby={hintId}
        onClick={() => {
          if (!armed) return setArmed(true);
          setArmed(false);
          onConfirm();
        }}
        className={`flex h-7 items-center self-start rounded-md px-1.5 -mx-1.5 text-sm font-medium transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 disabled:opacity-40 ${armed ? "text-critical" : "text-ink"}`}
      >
        {armed ? t("entry.menu.sure") : label}
      </button>
      <p id={hintId} className="text-xs text-ink-muted">
        {hint}
      </p>
    </div>
  );
}

/**
 * Bottone del profilo in fondo al binario e il suo pannello: tema, lingua,
 * «vedi come» (prototipo), Preferenze e — solo per chi la può vedere —
 * Amministrazione. Pannello non modale: Esc o un clic fuori lo chiudono e il
 * fuoco torna al bottone. In fondo «Sign out» e, nel riquadro «Prototype
 * only», i due reset del prototipo (area 9a, shape `entry.md` [IN 6]).
 */
export function ProfileMenu() {
  const { t, i18n } = useTranslation();
  const { viewer, setPersona } = useViewer();
  const navigate = useNavigate();
  const toast = useToast();
  const logout = useLogout();
  const resetPrototype = useResetPrototype();
  const resetEmpty = useResetToEmptyInstance();
  const { preference, setPreference } = useTheme();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const { data: people } = usePeople();
  const { data: departments } = useDepartments();
  const person = people?.find((p) => p.id === viewer.personId);
  const dept = departments?.find((d) => d.id === person?.departmentIds[0]);
  const deptColor = dept ? `var(${dept.colorToken})` : "var(--ink-muted)";

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    }
    function onPointer(e: PointerEvent) {
      const target = e.target as Node;
      if (panel.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
      // Il fuoco era nel pannello, che sparisce: torna al bottone, a meno che
      // il clic non l'abbia già dato a un altro controllo.
      window.setTimeout(() => {
        const active = document.activeElement;
        if (!active || active === document.body) trigger.current?.focus();
      }, 0);
    }
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const linkClass =
    "flex h-8 items-center rounded-md px-2 text-sm text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10";

  return (
    <div className="relative">
      <Tooltip label={person?.name ?? t("rail.profile")}>
        <button
          ref={trigger}
          type="button"
          aria-label={t("rail.profile")}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((v) => !v)}
          className="grid size-10 place-items-center rounded-lg transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10 aria-expanded:bg-ink/10"
        >
          <span
            aria-hidden="true"
            className="grid size-7 place-items-center rounded-full text-xs font-semibold"
            style={{
              color: deptColor,
              background: `color-mix(in oklch, ${deptColor} 18%, var(--rail))`,
            }}
          >
            {person?.initials}
          </span>
        </button>
      </Tooltip>
      {open && (
        <div
          ref={panel}
          id={panelId}
          role="dialog"
          aria-label={t("rail.profile")}
          tabIndex={-1}
          className="absolute bottom-0 left-full z-40 ml-3 flex max-h-[calc(100vh-24px)] w-76 flex-col overflow-y-auto rounded-lg border border-rule-strong bg-surface p-1.5 shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)] outline-none"
        >
          <div className="flex flex-col gap-0.5 border-b border-rule px-2 pt-1.5 pb-2.5">
            <span className="text-md font-semibold text-ink">{person?.name}</span>
            {dept && <span className="text-sm text-ink-muted">{dept.name}</span>}
          </div>
          <div className="border-b border-rule">
            <RadioGroup
              label={t("rail.theme")}
              name={`${panelId}-theme`}
              value={preference}
              options={THEMES.map((id) => ({ value: id, label: t(`rail.themes.${id}`) }))}
              onChange={setPreference}
            />
          </div>
          <div className="border-b border-rule">
            <RadioGroup
              label={t("rail.language")}
              name={`${panelId}-language`}
              value={(i18n.resolvedLanguage ?? "en") as Language}
              options={LANGUAGES.map((l) => ({ value: l.id, label: t(l.key) }))}
              onChange={setLanguage}
            />
          </div>
          <div className="border-b border-rule">
            <RadioGroup
              label={t("rail.viewAs")}
              name={`${panelId}-persona`}
              value={viewer.personId}
              options={VIEW_AS_PERSONAS.map((p) => ({
                value: p.personId,
                label: (
                  <>
                    <span className="block">{p.name}</span>{" "}
                    <span className="block text-xs text-ink-muted">{t(p.descriptionKey)}</span>
                  </>
                ),
              }))}
              onChange={setPersona}
            />
          </div>
          <nav aria-label={t("rail.profileLinks")} className="flex flex-col gap-0.5 pt-1.5">
            <Link to="/preferences" className={linkClass} onClick={() => setOpen(false)}>
              {t("nav.preferences")}
            </Link>
            {/* L'account Google personale (Drive, A1): un dialogo, finché non c'è Impostazioni → Account. */}
            <button
              type="button"
              className={`${linkClass} text-left`}
              onClick={() => {
                setOpen(false);
                openGoogleAccount();
              }}
            >
              {t("drive.account.menu")}
            </button>
            {canSeeAdmin(viewer) && (
              <Link to="/admin" className={linkClass} onClick={() => setOpen(false)}>
                {t("nav.admin")}
              </Link>
            )}
          </nav>
          <div className="mt-1.5 border-t border-rule pt-1.5">
            <button
              type="button"
              className={`${linkClass} w-full text-left disabled:opacity-40`}
              disabled={logout.isPending}
              onClick={() =>
                logout.mutate(undefined, {
                  onSuccess: () => {
                    setOpen(false);
                    void navigate({ to: "/login", replace: true });
                  },
                  onError: () => toast.error(t("entry.menu.signOutFailed")),
                })
              }
            >
              {t("entry.menu.signOut")}
            </button>
          </div>
          {/* Le simulazioni del prototipo, nel riquadro tratteggiato dell'8a. */}
          <div className="m-1.5 mt-2">
            <PrototypeBox>
              <ArmedReset
                label={t("entry.menu.resetPrototype")}
                hint={t("entry.menu.resetPrototypeHint")}
                onConfirm={() => {
                  setOpen(false);
                  resetPrototype();
                  void navigate({ to: "/home", replace: true });
                }}
              />
              <ArmedReset
                label={t("entry.menu.resetEmpty")}
                hint={t("entry.menu.resetEmptyHint")}
                disabled={resetEmpty.isPending}
                onConfirm={() =>
                  resetEmpty.mutate(undefined, {
                    onSuccess: () => {
                      setOpen(false);
                      void navigate({ to: "/setup", replace: true });
                    },
                    onError: () => toast.error(t("entry.menu.resetFailed")),
                  })
                }
              />
            </PrototypeBox>
          </div>
        </div>
      )}
    </div>
  );
}
