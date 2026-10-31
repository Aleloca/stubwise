import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  PROJECT_SWITCHES,
  useProjectSettings,
  useSaveProjectAutomations,
  type ProjectSettingsView,
  type ProjectSwitch,
} from "../../data/queries";
import type { Project } from "../../data/types";
import { SaveBar } from "../admin/parts";
import { ErrorLine } from "../entry/parts";
import { queryState } from "../home/blocks/BlockSection";
import { useFlash } from "../preferences/parts";
import { Switch } from "../preferences/SubscriptionRow";
import { primaryButton, quietButton } from "../tasks/controls";
import { smallInput } from "../automations/builder/controls";
import {
  LeaveConfirm,
  SettingsFrame,
  SettingsState,
  useLeaveGuard,
  useSettingsWrite,
} from "./SettingsFrame";
import { ViewOnlyLine } from "./ViewOnly";

// Progetto → Settings → Automations (shape project-settings.md
// «Automations»): «cosa fa da solo?». Cinque interruttori, ognuno con la
// frase di cosa cambia [PS 1]; i giorni del pulse sulla sua seconda riga;
// il tetto alle correzioni sotto un filetto. Le modifiche sono una bozza
// con la barra in fondo («2 changes · Discard · Save»). Le regole le dice
// il livello dati: i limiti dei numeri come `invalid` sotto il campo, il
// pulse senza discovery (`pulseNeedsBacklog`). Spegnere la discovery spegne
// il pulse nella bozza e lo dice; riaccenderla non lo riaccende [PS 8].

interface Draft {
  switches: Record<ProjectSwitch, boolean>;
  pulseDays: string;
  cap: string;
}

const draftOf = (v: ProjectSettingsView): Draft => ({
  switches: { ...v.switches },
  pulseDays: String(v.pulseEveryDays),
  cap: String(v.correctionCap),
});

/** Un numero scritto: `NaN` se non lo è (lo rifiuta il livello dati, che dice perché). */
const numberOf = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text));

function changesOf(draft: Draft, v: ProjectSettingsView): number {
  let n = PROJECT_SWITCHES.filter((sw) => draft.switches[sw] !== v.switches[sw]).length;
  if (numberOf(draft.pulseDays) !== v.pulseEveryDays) n++;
  if (numberOf(draft.cap) !== v.correctionCap) n++;
  return n;
}

/** Quanto resta a schermo «Pulse turned off too.» (shape: 4 s). */
const PULSE_NOTICE_MS = 4000;

export function AutomationSettings({ project }: { project: Project }) {
  const { t } = useTranslation();
  const settings = useProjectSettings(project.id);
  return (
    <SettingsFrame
      title={t("settings.sections.automations")}
      intro={t("settings.automations.intro", { code: project.code })}
    >
      <p className="-mt-3 pb-5 text-xs text-ink-faint">
        <Trans
          i18nKey="settings.automations.rulesElsewhere"
          components={{
            link: (
              <Link
                to="/p/$code/$section"
                params={{ code: project.code, section: "automations" }}
                className="font-medium text-ink-muted underline underline-offset-2 hover:text-ink"
              />
            ),
          }}
        />
      </p>
      <SettingsState
        state={queryState([settings])}
        error={t("settings.common.loadError", { code: project.code })}
      >
        {settings.data && (
          <AutomationForm view={settings.data} onReload={() => void settings.refetch()} />
        )}
      </SettingsState>
    </SettingsFrame>
  );
}

function AutomationForm({ view, onReload }: { view: ProjectSettingsView; onReload: () => void }) {
  const { t } = useTranslation();
  const access = view.access.automations;
  const canEdit = access.canEdit;
  const code = view.code;
  const save = useSaveProjectAutomations();
  const write = useSettingsWrite(code, onReload);
  const [edits, setEdits] = useState<Draft | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [pulseNotice, setPulseNotice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [justSaved, flash] = useFlash();
  const lineId = useId();
  const daysId = useId();
  const capId = useId();
  const notice = useRef<number | null>(null);
  useEffect(() => () => void (notice.current && window.clearTimeout(notice.current)), []);

  const draft = canEdit ? (edits ?? draftOf(view)) : draftOf(view);
  const changes = canEdit ? changesOf(draft, view) : 0;
  const guard = useLeaveGuard(changes > 0);
  // La regola la dice la lettura per lo stato salvato; nella bozza vale la
  // discovery della bozza (è quella che si salverebbe).
  const pulseNeedsBacklog =
    draft.switches.backlogDiscovery === view.switches.backlogDiscovery
      ? view.pulseNeedsBacklog
      : !draft.switches.backlogDiscovery;
  const readOnlyWhy = canEdit
    ? undefined
    : t(`settings.viewOnly.lines.${access.editAction ?? "manageProjectSettings"}`, { code });

  function setSwitch(sw: ProjectSwitch, on: boolean) {
    const switches = { ...draft.switches, [sw]: on };
    if (sw === "backlogDiscovery" && !on && switches.pulse) {
      switches.pulse = false;
      setPulseNotice(true);
      if (notice.current) window.clearTimeout(notice.current);
      notice.current = window.setTimeout(() => setPulseNotice(false), PULSE_NOTICE_MS);
    }
    setEdits({ ...draft, switches });
    if (invalid === "pulse_needs_backlog") setInvalid(null);
  }

  function discard() {
    setEdits(null);
    setInvalid(null);
  }

  async function submit() {
    if (busy || changes === 0) return;
    setBusy(true);
    setInvalid(null);
    const ok = await write.run(
      () =>
        save.mutateAsync({
          projectId: view.projectId,
          switches: draft.switches,
          pulseEveryDays: numberOf(draft.pulseDays),
          correctionCap: numberOf(draft.cap),
        }),
      setInvalid,
    );
    setBusy(false);
    if (!ok) return;
    guard.clear();
    setEdits(null);
    // Salvato: resta la frase della regola, non l'avviso di un momento fa.
    setPulseNotice(false);
    flash();
  }

  const capValue = numberOf(draft.cap);
  const capReading =
    Number.isInteger(capValue) && capValue >= 0
      ? capValue === 0
        ? t("settings.automations.capZero")
        : t("settings.automations.capN", { count: capValue })
      : null;

  return (
    <>
      {!canEdit && (
        <>
          {write.lost && <div className="pb-3">{write.message}</div>}
          <ViewOnlyLine
            id={lineId}
            action={access.editAction ?? "manageProjectSettings"}
            projectId={view.projectId}
            code={code}
          />
        </>
      )}
      <ul className="@container border-t border-rule">
        {PROJECT_SWITCHES.map((sw) => {
          const name = t(`settings.automations.switches.${sw}`);
          const isPulse = sw === "pulse";
          const ruleOff = isPulse && pulseNeedsBacklog;
          return (
            <li key={sw} data-switch-row={sw} className="border-b border-rule py-3.5 last:border-b-0">
              <div className="flex items-start gap-4">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span aria-hidden="true" className="text-md font-semibold text-ink">
                    {name}
                  </span>
                  <p id={`${lineId}-${sw}`} className="max-w-[64ch] text-sm text-pretty text-ink-muted">
                    {t(`settings.automations.effects.${sw}`, { code })}
                  </p>
                </div>
                <span className="flex h-6 shrink-0 items-center">
                  <Switch
                    checked={draft.switches[sw]}
                    label={name}
                    describedBy={canEdit ? `${lineId}-${sw}` : lineId}
                    // Spento per permesso: la frase della riga ○ (col suo «Who?»);
                    // il pulse senza discovery: la regola, senza «Who?».
                    disabledReason={
                      readOnlyWhy ?? (ruleOff ? t("settings.automations.pulseNeedsBacklog") : undefined)
                    }
                    onChange={(on) => setSwitch(sw, on)}
                  />
                </span>
              </div>
              {isPulse && (
                <div className="mt-2 flex flex-col gap-1.5">
                  {canEdit ? (
                    <NumberField
                      id={daysId}
                      label={t("settings.automations.pulseDaysLabel")}
                      before={t("settings.automations.every")}
                      after={t("settings.automations.days", { count: numberOf(draft.pulseDays) || 2 })}
                      value={draft.pulseDays}
                      disabled={!draft.switches.pulse}
                      error={invalid === "pulse_days" ? t("settings.automations.pulseDaysError") : null}
                      onChange={(pulseDays) => {
                        setEdits({ ...draft, pulseDays });
                        if (invalid === "pulse_days") setInvalid(null);
                      }}
                    />
                  ) : (
                    <p className="num text-sm text-ink">
                      {t("settings.automations.everyDays", { count: view.pulseEveryDays })}
                    </p>
                  )}
                  {ruleOff && (
                    <p aria-live="polite" className="text-xs text-ink-muted">
                      {pulseNotice
                        ? t("settings.automations.pulseTurnedOff")
                        : t("settings.automations.pulseNeedsBacklog")}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <section className="mt-8 border-t border-rule pt-4" aria-labelledby={`${capId}-title`}>
        <h2 id={`${capId}-title`} className="text-md font-semibold text-ink">
          {t("settings.automations.cap")}
        </h2>
        <p className="mt-0.5 max-w-[64ch] text-sm text-pretty text-ink-muted">
          {t("settings.automations.capBody")}
        </p>
        <div className="mt-3 flex flex-col gap-1.5">
          {canEdit ? (
            <NumberField
              id={capId}
              label={t("settings.automations.cap")}
              value={draft.cap}
              reading={capReading}
              error={invalid === "correction_cap" ? t("settings.automations.capError") : null}
              onChange={(cap) => {
                setEdits({ ...draft, cap });
                if (invalid === "correction_cap") setInvalid(null);
              }}
            />
          ) : (
            <p className="text-sm text-ink">
              <span className="num font-semibold">{view.correctionCap}</span>
              {" · "}
              {view.correctionCap === 0
                ? t("settings.automations.capZero")
                : t("settings.automations.capN", { count: view.correctionCap })}
            </p>
          )}
          <p className="text-xs text-ink-faint">{t("settings.automations.capZeroHint")}</p>
        </div>
      </section>

      <p className="mt-8 text-xs text-ink-faint">{t("settings.automations.prototype")}</p>

      {canEdit && (changes > 0 || justSaved || write.message) && (
        <div className="-mx-8 mt-8">
          <SaveBar width={880}>
            {invalid === "pulse_needs_backlog" && (
              <ErrorLine>{t("settings.automations.pulseNeedsBacklog")}</ErrorLine>
            )}
            {write.message}
            {changes === 0 ? (
              justSaved && (
                <p role="status" className="text-sm text-ink">
                  {t("settings.common.saved")}
                </p>
              )
            ) : guard.blocked ? (
              <LeaveConfirm
                guard={guard}
                message={t("settings.automations.leave", { count: changes })}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <p className="num min-w-0 flex-1 text-sm text-ink">
                  {t("settings.automations.changes", { count: changes })}
                </p>
                <button type="button" className={quietButton} onClick={discard}>
                  {t("settings.common.discard")}
                </button>
                <button
                  type="button"
                  aria-disabled={busy || undefined}
                  className={`${primaryButton} aria-disabled:opacity-40`}
                  onClick={() => void submit()}
                >
                  {t("settings.common.save")}
                </button>
              </div>
            )}
          </SaveBar>
        </div>
      )}
    </>
  );
}

/** Un campo numerico da 64 px (cifre tabellari), con le parole intorno, la lettura e l'errore sotto. */
function NumberField({
  id,
  label,
  before,
  after,
  value,
  disabled = false,
  reading,
  error,
  onChange,
}: {
  id: string;
  label: string;
  before?: string;
  after?: string;
  value: string;
  disabled?: boolean;
  reading?: string | null;
  error: string | null;
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <>
      <span className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        {before && <span aria-hidden="true">{before}</span>}
        <input
          id={id}
          type="number"
          inputMode="numeric"
          aria-label={label}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => onChange(e.target.value)}
          className={`${smallInput} num w-16 [appearance:textfield] text-right aria-invalid:border-critical disabled:cursor-not-allowed [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
        />
        {after && <span aria-hidden="true">{after}</span>}
        {reading && <span className="text-sm text-ink">{reading}</span>}
      </span>
      {error && <ErrorLine id={`${id}-error`}>{error}</ErrorLine>}
    </>
  );
}
