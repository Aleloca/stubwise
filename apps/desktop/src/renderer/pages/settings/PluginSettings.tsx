import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { WhoCanLink } from "../../components/WhoCanLink";
import {
  applyPluginPreset,
  pluginBothChanged,
  pluginChangedKeys,
  pluginChoosable,
  pluginDisabledInput,
  pluginHookKey,
  pluginOffKeys,
  pluginPresetApplied,
  pluginSkillKey,
  reconcilePluginDraft,
  useProjectPlugins,
  useProjectSettingsAccess,
  useSaveProjectPlugins,
  useSeesAdminPlugins,
  type ProjectPluginsView,
} from "../../data/queries";
import type { Project } from "../../data/types";
import { SaveBar } from "../admin/parts";
import { CrossGlyph } from "../admin/integrations/parts";
import { PluginStatusWords } from "../admin/integrations/PluginsPage";
import { WarningGlyph } from "../automations/glyphs";
import { ErrorLine } from "../entry/parts";
import { queryState } from "../home/blocks/BlockSection";
import { useFlash } from "../preferences/parts";
import { primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import {
  LeaveConfirm,
  SettingsFrame,
  SettingsState,
  useLeaveGuard,
  useSettingsWrite,
} from "./SettingsFrame";
import { ViewOnlyLine } from "./ViewOnly";

// Progetto → Settings → Plugins (area 9c, Task 10, shape project-plugins.md):
// i plugin del registro con le loro skill e i gruppi di hook, accesi per
// sottrazione; il plugin base in testa, senza caselle; i non pronti in fondo,
// senza caselle e con la ragione. La bozza è un insieme di chiavi stabili
// spente (`plugin:skill`, `plugin#Evento#i`); «Save» manda la `version` letta.
// Le regole (quali plugin si scelgono, il preset, la riconciliazione dopo un
// `conflict`) le dice il livello dati: qui si leggono.
// Il conflitto [PG 5] (confermato dal maintainer): la bozza resta, la pagina
// rilegge la versione nuova sotto, e chi ha scritto la bozza sceglie fra
// «Keep my changes on theirs» e «Use theirs»; nessuna delle due salva.

type PluginRow = ProjectPluginsView["plugins"][number];

interface Edits {
  /** Le chiavi spente della versione da cui la bozza è partita. */
  start: Set<string>;
  /** La `version` letta: quella che «Save» manda. */
  version: number;
  keys: Set<string>;
}

/** Quanto resta a schermo «Saved. From the next session…» (shape: 4 s). */
const SAVED_MS = 4000;
/** Oltre quante skill un plugin si apre con l'elenco chiuso [PG 6]. */
const SKILLS_OPEN_MAX = 12;
/** Quante righe «You both changed» nomina prima di «and 3 more». */
const BOTH_SHOWN = 5;

export function PluginSettings({ project }: { project: Project }) {
  const { t } = useTranslation();
  const plugins = useProjectPlugins(project.id);
  const seesAdmin = useSeesAdminPlugins();
  return (
    <SettingsFrame
      title={t("settings.sections.plugins")}
      intro={t("settings.plugins.intro", { code: project.code })}
    >
      <div className="-mt-3 flex flex-col gap-0.5 pb-5 text-xs text-ink-faint">
        <p>
          <Trans
            i18nKey="settings.plugins.registered"
            components={{
              link: seesAdmin ? (
                <Link
                  to="/admin/$section"
                  params={{ section: "plugins" }}
                  className="font-medium text-ink-muted underline underline-offset-2 hover:text-ink"
                />
              ) : (
                <span />
              ),
            }}
          />
        </p>
        <p>{t("settings.plugins.mcpNote")}</p>
      </div>
      <SettingsState
        state={queryState([plugins])}
        error={t("settings.plugins.loadError", { code: project.code })}
        rows={14}
      >
        {plugins.data && (
          <PluginsForm
            view={plugins.data}
            project={project}
            onReload={() => plugins.refetch()}
          />
        )}
      </SettingsState>
    </SettingsFrame>
  );
}

function PluginsForm({
  view,
  project,
  onReload,
}: {
  view: ProjectPluginsView;
  project: Project;
  onReload: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const code = project.code;
  const canEdit = view.canEdit;
  const editAction = useProjectSettingsAccess(project.id).plugins.editAction ?? "manageProjectSettings";
  const save = useSaveProjectPlugins();
  const write = useSettingsWrite(code, () => void onReload());
  const [edits, setEdits] = useState<Edits | null>(null);
  const [conflict, setConflict] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [busy, setBusy] = useState(false);
  const [justSaved, flash] = useFlash(SAVED_MS);
  const lineId = useId();
  const root = useRef<HTMLDivElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);

  const live = pluginOffKeys(view);
  // Senza permesso la bozza non conta: si legge ciò che è salvato (anche dopo un `forbidden`).
  const draft = canEdit ? edits : null;
  const keys = draft?.keys ?? live;
  const changed = draft ? pluginChangedKeys(draft.start, draft.keys) : new Set<string>();
  const changes = changed.size;
  // Dopo un `conflict`, le righe che abbiamo cambiato entrambi, sulla versione riletta.
  const both = draft && conflict ? pluginBothChanged(draft.start, draft.keys, live) : [];
  const guard = useLeaveGuard(changes > 0);

  const ready = view.plugins.filter(pluginChoosable);
  const notReady = view.plugins.filter((p) => !p.base && !pluginChoosable(p));
  const base = view.plugins.filter((p) => p.base);

  const heading = () =>
    root.current?.closest("section")?.querySelector<HTMLElement>("h1") ?? null;

  // La barra esce dopo «Saved»: il fuoco che stava sul suo bottone non cade sul body.
  const showBar = canEdit && (changes > 0 || justSaved || !!write.message || conflict);
  const hadBar = useRef(showBar);
  useEffect(() => {
    if (hadBar.current && !showBar && document.activeElement === document.body)
      heading()?.focus({ preventScroll: true });
    hadBar.current = showBar;
  }, [showBar]);

  function change(next: Set<string>) {
    setEdits({ start: draft?.start ?? live, version: draft?.version ?? view.version, keys: next });
    setInvalid(null);
  }

  function toggle(keyList: string[], on: boolean) {
    const next = new Set(keys);
    for (const key of keyList) {
      if (on) next.delete(key);
      else next.add(key);
    }
    change(next);
  }

  function applyPreset(p: PluginRow, header: HTMLElement | null) {
    const out = applyPluginPreset(p, keys);
    change(out.keys);
    setAnnounce(t("settings.plugins.presetDone", { count: out.turnedOff }));
    // Il bottone ora è spento: il fuoco va alla testata del plugin (shape §6).
    header?.focus({ preventScroll: true });
  }

  function discard() {
    setEdits(null);
    setInvalid(null);
    setAnnounce("");
  }

  async function submit() {
    if (busy || !draft || changes === 0) return;
    setBusy(true);
    setInvalid(null);
    await write.run(
      () =>
        save.mutateAsync({
          projectId: project.id,
          version: draft.version,
          disabled: pluginDisabledInput(view, draft.keys),
        }),
      setInvalid,
      () => {
        guard.clear();
        setEdits(null);
        setAnnounce("");
        flash();
      },
      () => {
        // [PG 5]: niente scritto, la bozza resta; sotto, la versione nuova.
        setConflict(true);
        void onReload();
      },
    );
    setBusy(false);
  }

  function keepMine() {
    if (!draft) return;
    const out = reconcilePluginDraft(draft.start, draft.keys, live);
    setEdits({ start: live, version: view.version, keys: out.keys });
    setConflict(false);
    requestAnimationFrame(() => saveButton.current?.focus({ preventScroll: true }));
  }

  function useTheirs() {
    discard();
    setConflict(false);
    guard.clear();
    requestAnimationFrame(() => heading()?.focus({ preventScroll: true }));
  }

  /** Il nome di una riga dalla sua chiave stabile: la skill, o la chiave del gruppo di hook. */
  function rowName(key: string): string {
    for (const p of ready) {
      const skill = p.skills.find((s) => pluginSkillKey(p.name, s.name) === key);
      if (skill) return skill.name;
      const hook = p.hooks.find((h) => pluginHookKey(p.name, h.key) === key);
      if (hook) return hook.key;
    }
    return key;
  }

  const bothNames = both.map(rowName);
  const bothText =
    bothNames.length > BOTH_SHOWN
      ? t("settings.plugins.conflict.more", {
          list: bothNames.slice(0, BOTH_SHOWN).join(", "),
          count: bothNames.length - BOTH_SHOWN,
        })
      : bothNames.join(", ");

  return (
    <div ref={root} className="flex flex-col">
      {!canEdit && (
        <>
          {write.lost && <div className="pb-3">{write.message}</div>}
          <ViewOnlyLine id={lineId} action={editAction} projectId={project.id} code={code} />
        </>
      )}
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>

      {base.map((p) => (
        <BasePlugin key={p.name} plugin={p} />
      ))}

      {ready.length === 0 && notReady.length === 0 && (
        <p className="border-t border-rule py-4 text-md text-pretty text-ink-muted">
          {t("settings.plugins.empty")}
        </p>
      )}

      {ready.map((p) => (
        <ReadyPlugin
          key={p.name}
          plugin={p}
          code={code}
          projectId={project.id}
          keys={keys}
          changed={changed}
          both={both}
          canEdit={canEdit}
          readOnlyId={canEdit ? undefined : lineId}
          editAction={editAction}
          onToggle={toggle}
          onPreset={applyPreset}
        />
      ))}

      {notReady.length > 0 && <NotReady plugins={notReady} />}

      {showBar && (
        // Figlia diretta della colonna: `sticky` la aggancia in fondo alla finestra.
        <SaveBar
          width={880}
          inset="-mx-8 mt-8 px-8"
          data={conflict ? { "data-conflict": "" } : { "data-save-bar": "" }}
        >
          {conflict && draft ? (
            <section
              aria-label={t("settings.plugins.conflict.label")}
              className="flex flex-col gap-3"
            >
              <p className="flex items-start gap-2 text-md text-pretty text-ink">
                <span className="mt-[3px] shrink-0">
                  <WarningGlyph />
                </span>
                <span className="min-w-0">
                  {t("settings.plugins.conflict.body")}
                  {both.length > 0 && (
                    <>
                      {" "}
                      <span>{t("settings.plugins.conflict.both", { rows: bothText })}</span>
                    </>
                  )}
                </span>
              </p>
              <div className="flex flex-wrap items-center gap-3 pl-6">
                <button type="button" className={primaryButton} onClick={keepMine}>
                  {t("settings.plugins.conflict.keepMine")}
                </button>
                <button type="button" className={secondaryButton} onClick={useTheirs}>
                  {t("settings.plugins.conflict.useTheirs")}
                </button>
              </div>
            </section>
          ) : (
            <>
              {invalid && (
                <ErrorLine>
                  {invalid === "base_plugin"
                    ? t("settings.plugins.basePluginRefused")
                    : t("settings.common.saveFailed")}
                </ErrorLine>
              )}
              {write.message}
              {guard.blocked && changes > 0 ? (
                <LeaveConfirm
                  guard={guard}
                  message={t("settings.plugins.leave", { count: changes })}
                />
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  {changes > 0 ? (
                    <p className="num min-w-0 flex-1 text-sm text-ink">
                      {t("settings.plugins.changes", { count: changes })}
                    </p>
                  ) : (
                    <p role="status" className="min-w-0 flex-1 text-xs text-ink-muted">
                      {justSaved ? t("settings.plugins.saved") : ""}
                    </p>
                  )}
                  {changes > 0 && (
                    <button type="button" className={quietButton} onClick={discard}>
                      {t("settings.common.discard")}
                    </button>
                  )}
                  {/* Resta montato dopo il salvataggio, spento: il fuoco non cade sul body. */}
                  <button
                    ref={saveButton}
                    type="button"
                    aria-disabled={busy || changes === 0 || undefined}
                    className={`${primaryButton} aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
                    onClick={() => void submit()}
                  >
                    {t("settings.common.save")}
                  </button>
                </div>
              )}
            </>
          )}
        </SaveBar>
      )}
    </div>
  );
}

/** Il plugin base: in testa, «Always on», le sue skill senza caselle [PG 2]. */
function BasePlugin({ plugin: p }: { plugin: PluginRow }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-t border-rule pb-4">
      <div className="flex min-h-12 items-center gap-3">
        <h2 id={id} className="text-md font-semibold text-ink">
          {p.name}
        </h2>
        <span className="min-w-0 flex-1 truncate text-sm text-ink-muted">
          {t("settings.plugins.base.label")}
        </span>
        <span className="shrink-0 text-xs font-semibold text-ink">
          {t("settings.plugins.base.alwaysOn")}
        </span>
      </div>
      <p className="max-w-[72ch] pb-2 text-sm text-pretty text-ink-muted">
        {t("settings.plugins.base.why")}
      </p>
      <ul className="@container">
        {p.skills.map((s) => (
          <li
            key={s.name}
            className="grid min-h-9 grid-cols-[minmax(0,14rem)_minmax(0,1fr)] items-center gap-x-4 @max-[600px]:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]"
          >
            <span className="num truncate text-sm font-semibold text-ink">{`/${p.name}:${s.name}`}</span>
            <span className="truncate text-sm text-ink-muted" title={s.description}>
              {s.description}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Una casella nativa, col tratto d'inchiostro; `mixed` per la casella del plugin. */
function Check({
  checked,
  mixed = false,
  label,
  disabled,
  describedBy,
  onChange,
}: {
  checked: boolean;
  mixed?: boolean;
  label: string;
  disabled: boolean;
  describedBy?: string;
  onChange: (on: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.checked)}
      className="size-4 shrink-0 accent-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}

/** Il punto ink da 6 px di una riga cambiata nella bozza, o «Both changed» dopo un conflitto. */
function ChangeMark({ changed, both }: { changed: boolean; both: boolean }) {
  const { t } = useTranslation();
  if (!changed || both) return <span aria-hidden="true" className="size-1.5 shrink-0" />;
  return (
    <span className="size-1.5 shrink-0 rounded-full bg-ink">
      <span className="sr-only">{t("settings.plugins.changed")}</span>
    </span>
  );
}

function ReadyPlugin({
  plugin: p,
  code,
  projectId,
  keys,
  changed,
  both,
  canEdit,
  readOnlyId,
  editAction,
  onToggle,
  onPreset,
}: {
  plugin: PluginRow;
  code: string;
  projectId: string;
  keys: ReadonlySet<string>;
  changed: ReadonlySet<string>;
  both: readonly string[];
  canEdit: boolean;
  readOnlyId?: string;
  editAction: string;
  onToggle: (keys: string[], on: boolean) => void;
  onPreset: (p: PluginRow, header: HTMLElement | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const header = useRef<HTMLHeadingElement>(null);
  const [open, setOpen] = useState(false);
  const skillKeys = p.skills.map((s) => pluginSkillKey(p.name, s.name));
  const hookKeys = p.hooks.map((h) => pluginHookKey(p.name, h.key));
  const all = [...skillKeys, ...hookKeys];
  const skillsOn = skillKeys.filter((k) => !keys.has(k)).length;
  const hooksOn = hookKeys.filter((k) => !keys.has(k)).length;
  const onCount = skillsOn + hooksOn;
  const presetSet = new Set(p.preset ?? []);
  const presetApplied = pluginPresetApplied(p, keys);
  const presetWhyId = `${id}-preset`;

  const parts = [t("settings.plugins.skillsOf", { on: skillsOn, count: p.skills.length })];
  if (p.hooks.length > 0)
    parts.push(t("settings.plugins.hooksOf", { on: hooksOn, count: p.hooks.length }));
  const count =
    onCount === 0
      ? t("settings.plugins.nothingInRuns")
      : t("settings.plugins.inRuns", { parts: parts.join(" · ") });

  // [PG 6]: oltre 12 skill l'elenco si chiude, ma le spente restano sempre visibili.
  const closed = p.skills.length > SKILLS_OPEN_MAX && !open;
  const skills = closed
    ? p.skills.filter((s) => keys.has(pluginSkillKey(p.name, s.name)))
    : p.skills;

  return (
    <section aria-labelledby={id} data-plugin={p.name} className="@container mt-6 border-t border-rule">
      <div className="flex min-h-[52px] flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule py-2">
        <span className="flex min-w-0 flex-1 items-center gap-3 @min-[760px]:flex-none">
          <span aria-hidden="true" className="size-1.5 shrink-0" />
          <Check
            checked={onCount === all.length}
            mixed={onCount > 0 && onCount < all.length}
            label={t("settings.plugins.usePlugin", { name: p.name, code })}
            disabled={!canEdit}
            describedBy={readOnlyId}
            onChange={(on) => onToggle(all, on)}
          />
          <h2
            id={id}
            ref={header}
            tabIndex={-1}
            className="text-md font-semibold text-ink outline-none"
          >
            {p.name}
          </h2>
          {p.slug !== p.name && <span className="num text-xs text-ink-faint">{p.slug}</span>}
          <PluginStatusWords status={p.status} />
        </span>
        <span className="flex basis-full items-center justify-end gap-3 @min-[760px]:ml-auto @min-[760px]:basis-auto">
          <span aria-live="polite" className="num text-sm text-ink-muted">
            {count}
          </span>
          {p.preset && (
            <PresetButton
              enabled={canEdit && !presetApplied}
              applied={presetApplied}
              whyId={canEdit ? presetWhyId : readOnlyId}
              projectId={projectId}
              code={code}
              editAction={editAction}
              canEdit={canEdit}
              onApply={() => onPreset(p, header.current)}
            />
          )}
        </span>
      </div>

      {p.skills.length > 0 && (
        <>
          <GroupHeading label={t("settings.plugins.skills")} count={p.skills.length} />
          <ul aria-label={t("settings.plugins.skills")}>
            {skills.map((s) => {
              const key = pluginSkillKey(p.name, s.name);
              const off = keys.has(key);
              const isBoth = both.includes(key);
              return (
                <li
                  key={s.name}
                  data-plugin-row={key}
                  className="flex min-h-11 items-center gap-3 border-b border-rule"
                >
                  <ChangeMark changed={changed.has(key)} both={isBoth} />
                  <Check
                    checked={!off}
                    label={t("settings.plugins.useSkill", { name: s.name })}
                    disabled={!canEdit}
                    describedBy={readOnlyId}
                    onChange={(on) => onToggle([key], on)}
                  />
                  <span
                    className={`w-60 shrink-0 truncate text-md ${off ? "text-ink-muted" : "text-ink"}`}
                    title={s.name}
                  >
                    {s.name}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-sm text-ink-muted"
                    title={s.description}
                  >
                    {s.description}
                  </span>
                  <RowMarks
                    off={off}
                    offWord={t("settings.plugins.offSkill")}
                    preset={off && presetSet.has(s.name)}
                    both={isBoth}
                  />
                </li>
              );
            })}
          </ul>
          {closed && (
            <button
              type="button"
              className={`${quietButton} mt-2 self-start`}
              onClick={() => setOpen(true)}
            >
              {t("settings.plugins.showSkills", { count: p.skills.length })}
            </button>
          )}
        </>
      )}

      {p.hooks.length > 0 && (
        <>
          <GroupHeading label={t("settings.plugins.hooks")} count={p.hooks.length} />
          <ul aria-label={t("settings.plugins.hooks")}>
            {p.hooks.map((h) => {
              const key = pluginHookKey(p.name, h.key);
              const off = keys.has(key);
              const isBoth = both.includes(key);
              return (
                <li
                  key={h.key}
                  data-plugin-row={key}
                  className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule py-1.5"
                >
                  <ChangeMark changed={changed.has(key)} both={isBoth} />
                  <Check
                    checked={!off}
                    label={t("settings.plugins.useHook", { key: h.key })}
                    disabled={!canEdit}
                    describedBy={readOnlyId}
                    onChange={(on) => onToggle([key], on)}
                  />
                  <span className={`num w-36 shrink-0 text-sm font-semibold ${off ? "text-ink-muted" : "text-ink"}`}>
                    {h.key}
                  </span>
                  <span className="w-32 shrink-0 truncate text-sm text-ink-muted">
                    {t(`settings.plugins.events.${h.event}`, { defaultValue: h.event })}
                  </span>
                  {h.command && (
                    <code
                      title={h.command}
                      className="block min-w-0 flex-1 truncate rounded-sm bg-ink/5 px-2 py-1 font-mono text-xs text-ink-muted @max-[759px]:order-last @max-[759px]:ml-[46px] @max-[759px]:basis-full"
                    >
                      {h.command}
                    </code>
                  )}
                  <RowMarks
                    off={off}
                    offWord={t("settings.plugins.offHook")}
                    preset={false}
                    both={isBoth}
                  />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/** I segni a destra di una riga: «Off», «Preset» (col perché nel `title`), «Both changed». */
function RowMarks({
  off,
  offWord,
  preset,
  both,
}: {
  off: boolean;
  offWord: string;
  preset: boolean;
  both: boolean;
}) {
  const { t } = useTranslation();
  if (!off && !both) return null;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap">
      {both && <span className="font-semibold text-ink">{t("settings.plugins.bothChanged")}</span>}
      {both && off && <span aria-hidden="true" className="text-ink-faint">·</span>}
      {off && <span className="font-semibold text-ink">{offWord}</span>}
      {preset && (
        <>
          <span aria-hidden="true" className="text-ink-faint">
            ·
          </span>
          <span className="text-ink-faint" title={t("settings.plugins.presetTitle")}>
            {t("settings.plugins.preset")}
          </span>
        </>
      )}
    </span>
  );
}

/**
 * «Apply recommended preset»: spento per permesso (la riga ○ e il «Who?»
 * accanto) o per regola («Preset applied», nessun «Who?»).
 */
function PresetButton({
  enabled,
  applied,
  whyId,
  projectId,
  code,
  editAction,
  canEdit,
  onApply,
}: {
  enabled: boolean;
  applied: boolean;
  whyId?: string;
  projectId: string;
  code: string;
  editAction: string;
  canEdit: boolean;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  return (
    <span className="flex shrink-0 items-center gap-2">
      {!canEdit && <WhoCanLink action={editAction} projectId={projectId} projectCode={code} />}
      {canEdit && applied && (
        <span id={whyId} className="text-xs text-ink-faint">
          {t("settings.plugins.presetApplied")}
        </span>
      )}
      <button
        type="button"
        title={t("settings.plugins.applyPresetTitle")}
        aria-disabled={!enabled || undefined}
        aria-describedby={enabled ? undefined : whyId}
        onClick={() => enabled && onApply()}
        className={`${secondaryButton} aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
      >
        {t("settings.plugins.applyPreset")}
      </button>
    </span>
  );
}

/** I plugin non pronti [PG 4]: in fondo, senza caselle né conteggio, con la ragione. */
function NotReady({ plugins }: { plugins: PluginRow[] }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} className="heading-group border-b border-rule pb-1.5">
        {t("settings.plugins.notInRuns")}
      </h2>
      {plugins.map((p) => (
        <NotReadyPlugin key={p.name} plugin={p} />
      ))}
    </section>
  );
}

function NotReadyPlugin({ plugin: p }: { plugin: PluginRow }) {
  const { t } = useTranslation();
  const id = useId();
  const failed = p.status === "failed";
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1 border-b border-rule py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={id} className="text-md font-semibold text-ink-muted">
          {p.name}
        </h3>
        {p.slug !== p.name && <span className="num text-xs text-ink-faint">{p.slug}</span>}
      </div>
      <p className="flex items-start gap-1.5 text-sm text-pretty text-ink-muted">
        <span className={`mt-[3px] shrink-0 ${failed ? "text-critical" : ""}`}>
          {failed ? <CrossGlyph /> : <DottedCircle />}
        </span>
        <span className="min-w-0">
          <Trans
            i18nKey={`settings.plugins.notReady.${failed ? "failed" : "materializing"}`}
            components={{
              status: <span className={failed ? "font-medium text-critical" : "font-medium"} />,
            }}
          />
        </span>
      </p>
      <p className="pl-[18px] text-xs text-ink-faint">{t("settings.plugins.keptChoices")}</p>
    </section>
  );
}

function GroupHeading({ label, count }: { label: string; count: number }): ReactNode {
  return (
    <p aria-hidden="true" className="mt-4 flex items-baseline gap-2 border-b border-rule pb-1.5">
      <span className="heading-group">{label}</span>
      <span className="num text-xs text-ink-faint">{count}</span>
    </p>
  );
}

/** «◌»: il cerchio tratteggiato di ciò che si sta preparando. */
function DottedCircle() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeDasharray="2.2 2.2"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="5.5" />
    </svg>
  );
}
