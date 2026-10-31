import { Link } from "@tanstack/react-router";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useCanSeeAdminSection,
  useProjectSettings,
  useSetProjectAi,
  type ProjectSettingsView,
} from "../../data/queries";
import type { Project } from "../../data/types";
import { ErrorLine } from "../entry/parts";
import { queryState } from "../home/blocks/BlockSection";
import { WarningBox } from "../admin/integrations/parts";
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

// Progetto → Settings → AI (shape project-settings.md «AI»): «con quale
// account?». Un gruppo di righe radio — «Automatic» e gli account
// dell'istanza (nome, tipo, stato in parole solo se non è normale) — e
// «Use only this account», spenta finché non c'è un account (regola, senza
// «Who?»). La catena di «Automatic», lo stato degli account e l'account
// eliminato li dice la lettura (`automaticChain`, `choices`,
// `chosenUnavailable`): la pagina li mette in parole.

type Choice = ProjectSettingsView["ai"]["choices"][number];
interface Draft {
  providerId: string | null;
  exclusive: boolean;
}

/** Il punto di partenza: l'account eliminato vale «Automatic» già nella bozza. */
const savedDraft = (ai: ProjectSettingsView["ai"]): Draft =>
  ai.chosenUnavailable
    ? { providerId: null, exclusive: false }
    : { providerId: ai.providerId, exclusive: ai.exclusive };

export function AiSettings({ project }: { project: Project }) {
  const { t } = useTranslation();
  const settings = useProjectSettings(project.id);
  return (
    <SettingsFrame
      title={t("settings.sections.ai")}
      intro={t("settings.ai.intro", { code: project.code })}
    >
      <SettingsState
        state={queryState([settings])}
        error={t("settings.common.loadError", { code: project.code })}
        rows={4}
      >
        {settings.data && <AiForm view={settings.data} onReload={() => void settings.refetch()} />}
      </SettingsState>
    </SettingsFrame>
  );
}

function AiForm({ view, onReload }: { view: ProjectSettingsView; onReload: () => void }) {
  const { t } = useTranslation();
  const access = view.access.ai;
  const canEdit = access.canEdit;
  const { ai, code } = view;
  const set = useSetProjectAi();
  const write = useSettingsWrite(code, onReload);
  const seesAdminAi = useCanSeeAdminSection("ai");
  const [edits, setEdits] = useState<Draft | null>(null);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [justSaved, flash] = useFlash();
  const lineId = useId();
  const groupId = useId();
  const onlyId = useId();
  const saved = savedDraft(ai);
  const draft = canEdit ? (edits ?? saved) : saved;
  // Salvare conferma anche «Automatic» al posto dell'account eliminato.
  const dirty =
    ai.chosenUnavailable ||
    draft.providerId !== saved.providerId ||
    draft.exclusive !== saved.exclusive;
  const guard = useLeaveGuard(canEdit && edits !== null && dirty);
  const chosen = ai.choices.find((c) => c.id === draft.providerId) ?? null;
  const disabledBy = canEdit ? undefined : lineId;

  async function save() {
    if (!dirty || busy) return;
    setBusy(true);
    setGone(false);
    const ok = await write.run(
      () =>
        set.mutateAsync({
          projectId: view.projectId,
          providerId: draft.providerId,
          exclusive: draft.providerId !== null && draft.exclusive,
        }),
      (reason) => {
        // L'account è sparito fra lettura e salvataggio: si dice e si rilegge.
        if (reason === "provider") {
          setGone(true);
          setEdits(null);
          onReload();
        }
      },
    );
    setBusy(false);
    if (!ok) return;
    guard.clear();
    setEdits(null);
    flash();
  }

  const chain = ai.automaticChain;
  const automaticBody =
    chain.length === 0
      ? t("settings.ai.automaticNone")
      : t("settings.ai.automaticBody", {
          count: chain.length,
          names: chain.join(t("settings.ai.then")),
        });

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
      {ai.chosenUnavailable && (
        <div className="pb-4">
          <WarningBox>
            {canEdit ? t("settings.ai.deleted", { code }) : t("settings.ai.deletedRead", { code })}
          </WarningBox>
        </div>
      )}
      {ai.choices.length === 0 && (
        <div className="flex flex-col items-start gap-2 pb-4">
          <p className="max-w-[72ch] text-md text-pretty text-ink">{t("settings.ai.none")}</p>
          {seesAdminAi && (
            <Link
              to="/admin/$section"
              params={{ section: "ai" }}
              className="text-sm font-medium text-ink underline underline-offset-2 hover:text-ink-muted"
            >
              {t("settings.ai.noneLink")}
            </Link>
          )}
        </div>
      )}
      <fieldset aria-labelledby={groupId} className="border-t border-rule">
        <legend id={groupId} className="sr-only">
          {t("settings.ai.account")}
        </legend>
        <RadioRow
          name={groupId}
          checked={draft.providerId === null}
          title={t("settings.ai.automatic")}
          body={automaticBody}
          describedBy={disabledBy}
          disabled={!canEdit}
          onChoose={() => setEdits({ providerId: null, exclusive: false })}
        />
        {ai.choices.map((c) => (
          <RadioRow
            key={c.id}
            name={groupId}
            checked={draft.providerId === c.id}
            title={c.name}
            body={t(`settings.ai.kinds.${c.kind}`)}
            status={<AccountStatus choice={c} />}
            // Spento e scelto: con «Use only this account» il lavoro parte senza
            // account (`pickProvider` dà `null`), senza vale Automatic (I4).
            note={
              draft.providerId === c.id && !c.enabled
                ? draft.exclusive
                  ? t("settings.ai.chosenOffExclusive", { code })
                  : t("settings.ai.chosenOff")
                : undefined
            }
            describedBy={disabledBy}
            disabled={!canEdit}
            onChoose={() => setEdits({ providerId: c.id, exclusive: draft.exclusive })}
          />
        ))}
      </fieldset>
      {gone && (
        <div className="pt-3">
          <ErrorLine>{t("settings.ai.providerGone")}</ErrorLine>
        </div>
      )}

      <div className="mt-5 flex flex-col gap-1.5">
        <label className="flex w-fit items-center gap-2.5 text-md text-ink has-disabled:text-ink-muted">
          <input
            type="checkbox"
            checked={chosen !== null && draft.exclusive}
            disabled={!canEdit || chosen === null}
            aria-describedby={!canEdit ? lineId : chosen === null ? onlyId : `${onlyId}-effect`}
            onChange={(e) => setEdits({ ...draft, exclusive: e.target.checked })}
            className="size-4 accent-[var(--color-ink)] disabled:cursor-not-allowed"
          />
          {t("settings.ai.exclusive")}
        </label>
        {chosen === null ? (
          <p id={onlyId} className="pl-[26px] text-xs text-ink-muted">
            {t("settings.ai.exclusiveNeedsAccount")}
          </p>
        ) : (
          <p
            id={`${onlyId}-effect`}
            className="max-w-[72ch] pl-[26px] text-sm text-pretty text-ink-muted"
          >
            {draft.exclusive
              ? t("settings.ai.exclusiveOn", { name: chosen.name, code })
              : t("settings.ai.exclusiveOff", { name: chosen.name })}
          </p>
        )}
      </div>

      {canEdit && (
        <div className="mt-6 flex flex-col gap-3">
          {write.message}
          <LeaveConfirm guard={guard} />
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-disabled={!dirty || busy || undefined}
              onClick={() => void save()}
              className={`${primaryButton} aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
            >
              {t("settings.common.save")}
            </button>
            <SavedNote on={justSaved} />
          </div>
        </div>
      )}
      <p className="mt-6 text-xs text-ink-faint">{t("settings.ai.runsKeep")}</p>
    </>
  );
}

/** Lo stato dell'account, solo se non è normale: glifo e parola, mai il solo colore. */
function AccountStatus({ choice }: { choice: Choice }) {
  const { t } = useTranslation();
  if (!choice.enabled)
    return (
      <span className="flex items-center gap-1.5 text-sm text-ink-muted">
        <span aria-hidden="true" className="size-2 rounded-full border border-current" />
        {t("settings.ai.off")}
      </span>
    );
  if (choice.limited)
    return (
      <span className="flex items-center gap-1.5 text-sm text-critical">
        <span aria-hidden="true" className="size-2 rounded-full bg-current" />
        {t("settings.ai.limited")}
      </span>
    );
  return null;
}

/** Una riga del gruppo: radio, nome 600 e seconda riga; lo stato a destra. */
function RadioRow({
  name,
  checked,
  title,
  body,
  status,
  note,
  describedBy,
  disabled,
  onChoose,
}: {
  name: string;
  checked: boolean;
  title: string;
  body: string;
  status?: ReactNode;
  note?: string;
  describedBy?: string;
  disabled: boolean;
  onChoose: () => void;
}) {
  const id = useId();
  return (
    <div className="border-b border-rule">
      <label
        htmlFor={id}
        className={`flex min-h-[52px] items-start gap-3 py-2.5 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      >
        <input
          id={id}
          type="radio"
          name={name}
          checked={checked}
          disabled={disabled}
          aria-describedby={[describedBy, `${id}-body`].filter(Boolean).join(" ") || undefined}
          onChange={onChoose}
          className="mt-[3px] size-4 shrink-0 accent-[var(--color-ink)] disabled:cursor-not-allowed"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-md font-semibold text-ink">{title}</span>
          <span id={`${id}-body`} className="max-w-[64ch] text-sm text-pretty text-ink-muted">
            {body}
          </span>
          {note && <span className="text-sm text-ink">{note}</span>}
        </span>
        {status && <span className="shrink-0 pt-0.5">{status}</span>}
      </label>
    </div>
  );
}
