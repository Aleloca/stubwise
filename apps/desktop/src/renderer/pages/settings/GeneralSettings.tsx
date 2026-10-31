import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  DESCRIPTION_MAX,
  NAME_MAX,
  useProjectSettings,
  useUpdateProjectGeneral,
  type ProjectSettingsView,
} from "../../data/queries";
import type { Project } from "../../data/types";
import { ErrorLine } from "../entry/parts";
import { queryState } from "../home/blocks/BlockSection";
import { useFlash } from "../preferences/parts";
import { primaryButton } from "../tasks/controls";
import {
  LeaveConfirm,
  SavedNote,
  SettingsFrame,
  SettingsState,
  useLeaveGuard,
  useSettingsWrite,
} from "./SettingsFrame";
import { ViewOnlyLine } from "./ViewOnly";

// Progetto → Settings → General (shape project-settings.md «General»):
// «come si chiama?». Nome e descrizione si cambiano con
// `project.settings.manage` (lo dice `access.general` della lettura); il
// codice è testo, con il perché non cambia mai [PS 5]. Save acceso solo con
// una modifica, «Saved» accanto per 2 s; il nome nuovo arriva da solo in
// colonna, binario e ⌘K (le aree che la scrittura ricarica). In sola
// lettura: i valori come testo e la riga ○, nessun bottone.

const fieldClass =
  "w-full rounded-md border border-rule-strong bg-transparent px-2.5 text-md text-ink placeholder:text-ink-faint transition-colors duration-[var(--duration-fast)] ease-out hover:border-ink/40 focus-visible:border-transparent aria-invalid:border-critical";

export function GeneralSettings({ project }: { project: Project }) {
  const { t } = useTranslation();
  const settings = useProjectSettings(project.id);
  return (
    <SettingsFrame title={t("settings.sections.general")} intro={t("settings.general.intro")}>
      <SettingsState
        state={queryState([settings])}
        error={t("settings.common.loadError", { code: project.code })}
        rows={3}
      >
        {settings.data && (
          <GeneralForm
            // Una lettura nuova dopo un salvataggio non rimonta: la bozza la azzera chi salva.
            view={settings.data}
            onReload={() => void settings.refetch()}
          />
        )}
      </SettingsState>
    </SettingsFrame>
  );
}

function GeneralForm({ view, onReload }: { view: ProjectSettingsView; onReload: () => void }) {
  const { t } = useTranslation();
  const access = view.access.general;
  const update = useUpdateProjectGeneral();
  const write = useSettingsWrite(view.code, onReload);
  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [justSaved, flash] = useFlash();
  const lineId = useId();
  const nameId = useId();
  const descriptionId = useId();
  const draftName = name ?? view.name;
  const draftDescription = description ?? view.description;
  const dirty = draftName !== view.name || draftDescription !== view.description;
  const guard = useLeaveGuard(access.canEdit && dirty);

  // Permesso perso nel frattempo: la bozza si perde, e la frase lo dice.
  if (!access.canEdit && (name !== null || description !== null)) {
    setName(null);
    setDescription(null);
  }

  async function save() {
    if (!dirty || busy) return;
    setBusy(true);
    setInvalid(null);
    await write.run(
      () =>
        update.mutateAsync({
          projectId: view.projectId,
          ...(draftName !== view.name ? { name: draftName } : {}),
          ...(draftDescription !== view.description ? { description: draftDescription } : {}),
        }),
      setInvalid,
      // Il seguito sta in `onDone`: vale anche dopo un Retry riuscito.
      () => {
        guard.clear();
        setName(null);
        setDescription(null);
        flash();
      },
    );
    setBusy(false);
  }

  if (!access.canEdit)
    return (
      <>
        {write.lost && <div className="pb-3">{write.message}</div>}
        <ViewOnlyLine
          id={lineId}
          action={access.editAction ?? "manageProjectSettings"}
          projectId={view.projectId}
          code={view.code}
        />
        <dl className="@container border-t border-rule">
          <Row label={t("settings.general.name")}>
            <dd className="text-md text-ink [overflow-wrap:anywhere] @min-[720px]:pt-2">
              {view.name}
            </dd>
          </Row>
          <Row label={t("settings.general.description")}>
            <dd
              className={`max-w-[72ch] text-md whitespace-pre-line [overflow-wrap:anywhere] @min-[720px]:pt-2 ${view.description ? "text-ink" : "text-ink-muted"}`}
            >
              {view.description || t("settings.general.noDescription")}
            </dd>
          </Row>
          <CodeRow code={view.code} />
        </dl>
      </>
    );

  const nameError = invalid === "name" ? t("settings.general.nameError") : null;
  const descriptionError =
    invalid === "description" ? t("settings.general.descriptionError") : null;
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <dl className="@container border-t border-rule">
        <Row label={t("settings.general.name")} htmlFor={nameId}>
          <dd className="flex flex-col gap-1.5">
            <input
              id={nameId}
              value={draftName}
              maxLength={NAME_MAX}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? `${nameId}-error` : undefined}
              onChange={(e) => {
                setName(e.target.value);
                if (invalid === "name") setInvalid(null);
              }}
              className={`${fieldClass} h-9`}
            />
            {nameError && <ErrorLine id={`${nameId}-error`}>{nameError}</ErrorLine>}
          </dd>
        </Row>
        <Row
          label={t("settings.general.description")}
          note={t("settings.general.optional")}
          htmlFor={descriptionId}
        >
          <dd className="flex flex-col gap-1.5">
            <textarea
              id={descriptionId}
              rows={4}
              value={draftDescription}
              maxLength={DESCRIPTION_MAX}
              placeholder={t("settings.general.descriptionPlaceholder")}
              aria-invalid={descriptionError ? true : undefined}
              aria-describedby={`${descriptionId}-hint${descriptionError ? ` ${descriptionId}-error` : ""}`}
              onChange={(e) => {
                setDescription(e.target.value);
                if (invalid === "description") setInvalid(null);
              }}
              // Quattro righe che crescono fino a dieci, poi scorre.
              className={`${fieldClass} max-h-[218px] min-h-[98px] resize-none py-2 leading-5 [field-sizing:content]`}
            />
            <p id={`${descriptionId}-hint`} className="text-xs text-ink-muted">
              {t("settings.general.descriptionHint")}
            </p>
            {descriptionError && (
              <ErrorLine id={`${descriptionId}-error`}>{descriptionError}</ErrorLine>
            )}
          </dd>
        </Row>
        <CodeRow code={view.code} />
      </dl>
      <div className="mt-6 flex flex-col gap-3">
        {write.message}
        <LeaveConfirm guard={guard} />
        <div className="flex items-center gap-3">
          {/* `aria-disabled`, non `disabled`: dopo Save il fuoco resta sul bottone. */}
          <button
            type="submit"
            aria-disabled={!dirty || busy || undefined}
            className={`${primaryButton} aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
          >
            {t("settings.common.save")}
          </button>
          <SavedNote on={justSaved} />
        </div>
      </div>
    </form>
  );
}

/** Una riga del modulo: etichetta a sinistra (140 px) da larga, sopra il campo da stretta. */
function Row({
  label,
  note,
  htmlFor,
  children,
}: {
  label: string;
  note?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  const text = (
    <>
      {label}
      {note && <span className="ml-1 font-normal text-ink-faint">({note})</span>}
    </>
  );
  return (
    <div className="flex flex-col gap-1.5 border-b border-rule py-4 @min-[720px]:grid @min-[720px]:grid-cols-[140px_minmax(0,560px)] @min-[720px]:gap-x-6">
      <dt className="text-sm font-medium text-ink @min-[720px]:pt-2">
        {htmlFor ? <label htmlFor={htmlFor}>{text}</label> : text}
      </dt>
      {children}
    </div>
  );
}

/** Il codice: testo (non un campo spento), con il perché non cambia [PS 5]. */
function CodeRow({ code }: { code: string }) {
  const { t } = useTranslation();
  return (
    <Row label={t("settings.general.code")}>
      <dd className="flex flex-col gap-1 @min-[720px]:pt-2">
        <span data-project-code className="num text-md font-semibold text-ink">
          {code}
        </span>
        <span className="max-w-[62ch] text-xs text-pretty text-ink-muted">
          {t("settings.general.codeHint", { code })}
        </span>
      </dd>
    </Row>
  );
}
