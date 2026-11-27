import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PersonRef, WorkspaceEffect } from "../../../data/queries";

// La riga dell'effetto (shape `workspaces.md`, [WS 4]): prima di salvare,
// chi comincia e chi smette di vedere ogni progetto toccato, e cosa
// bloccherebbe la scrittura. La calcola il livello dati
// (`previewWorkspace`), la UI la dice soltanto. `aria-live`: cambia mentre si
// spuntano i progetti.

const NAMES_SHOWN = 2;

function Names({ people }: { people: PersonRef[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const shown = people.slice(0, NAMES_SHOWN).map((p) => p.name);
  const rest = people.length - shown.length;
  return (
    <>
      {rest > 0
        ? t("workspaces.effect.namesMore", { names: shown.join(", "), count: rest })
        : shown.join(t("workspaces.effect.and"))}
      {rest > 0 && (
        <>
          {" "}
          <button
            type="button"
            aria-expanded={open}
            className="underline"
            onClick={() => setOpen((o) => !o)}
          >
            {t("workspaces.effect.who")}
          </button>
          {open && (
            <ul className="mt-1 ml-4 list-disc">
              {people.map((p) => (
                <li key={p.personId}>{p.name}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

/** Le frasi dell'effetto; `null` finché non c'è niente da dire. */
export function EffectLine({ effect }: { effect: WorkspaceEffect | undefined }) {
  const { t } = useTranslation();
  if (!effect) return null;
  const lines = effect.projects.flatMap((p) => [
    ...(p.startSeeing.length > 0
      ? [
          <p key={`${p.projectId}-start`} data-effect="start">
            {t("workspaces.effect.start", { count: p.startSeeing.length, code: p.code })}{" "}
            <Names people={p.startSeeing} />.
          </p>,
        ]
      : []),
    ...(p.stopSeeing.length > 0
      ? [
          <p key={`${p.projectId}-stop`} data-effect="stop">
            {t("workspaces.effect.stop", { count: p.stopSeeing.length, code: p.code })}{" "}
            <Names people={p.stopSeeing} />.
          </p>,
        ]
      : []),
  ]);
  return (
    <div aria-live="polite" className="flex flex-col gap-1 text-sm text-ink-muted">
      {lines}
      {effect.notManaged.map((code) => (
        <p key={`nm-${code}`} data-effect="not-managed" className="text-critical">
          {t("workspaces.refusals.notManaged", { code })}
        </p>
      ))}
      {effect.escalation.map((e) => (
        <p key={`esc-${e.code}`} data-effect="escalation" className="text-critical">
          {t("workspaces.refusals.escalation", { code: e.code })}
        </p>
      ))}
      {effect.lastManager.map((code) => (
        <p key={`lm-${code}`} data-effect="last-manager" className="text-critical">
          {t("workspaces.refusals.lastManager", { code })}
        </p>
      ))}
    </div>
  );
}

/** L'effetto blocca la scrittura: la scelta resta spenta col motivo. */
export const blocks = (effect: WorkspaceEffect | undefined): boolean =>
  !!effect &&
  (effect.notManaged.length > 0 || effect.escalation.length > 0 || effect.lastManager.length > 0);
