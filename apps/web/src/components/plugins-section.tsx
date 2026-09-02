import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  ApiError,
  createPlugin,
  deletePlugin,
  smokePlugin,
  updatePluginRef,
  type Plugin,
  type PluginInventory,
} from "../lib/api";
import { pluginsQueryOptions } from "../lib/queries";
import { translateApiError } from "../lib/translate-api-error";
import { CollapsibleSection } from "./collapsible-section";
import { FormError, SubmitButton, TextField } from "./field";

/**
 * Sezione "Plugin" delle impostazioni (solo admin): il REGISTRO D'ISTANZA dei
 * plugin di Claude Code. Ogni riga mostra il plugin, lo stato della
 * materializzazione, l'esito dello smoke run e l'inventario di ciò che porta
 * dentro i run dell'agente (skill, comandi, agenti, hook col comando in
 * chiaro). Azioni: registra, aggiorna a un altro ref, riprova lo smoke, rimuovi.
 *
 * Il lavoro vero lo fa il WORKER: il server accoda un job e risponde 202. La
 * lista polla finché c'è almeno un job in volo (vedi `pluginsRefetchInterval`).
 *
 * Le raccomandazioni che viaggiano col GET (`recommendations`) non si usano
 * qui: servono alla sezione Plugin della pagina progetto, dove si sceglie cosa
 * spegnere per quel progetto.
 */
export function PluginsSection() {
  const { t } = useTranslation();
  const { data: registry } = useSuspenseQuery(pluginsQueryOptions);
  const [creating, setCreating] = useState(false);

  return (
    <section className="rounded-sm border border-line bg-ink-900 lg:col-span-2">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
            {t("settings:plugins.title")}
          </h2>
          <p className="mt-1 font-mono text-[11px] text-fg-faint">
            {t("settings:plugins.subtitle")}
          </p>
        </div>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim"
          >
            {t("settings:plugins.newPlugin")}
          </button>
        )}
      </header>

      {creating && (
        <div className="border-b border-line px-4 py-4">
          <NewPluginForm onDone={() => setCreating(false)} />
        </div>
      )}

      {registry.plugins.length === 0 && !creating ? (
        <p className="px-4 py-8 text-center font-mono text-[12px] tracking-[0.14em] text-fg-faint uppercase">
          {t("settings:plugins.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {registry.plugins.map((plugin) => (
            <PluginRow key={plugin.id} plugin={plugin} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Messaggio d'errore della registrazione. Il 409 `plugin_slug_taken` è l'unico
 * caso con un trattamento suo: lo slug non si può scegliere (lo deriva il
 * server dall'URL), quindi l'unica via d'uscita è rimuovere il plugin che ce
 * l'ha già — e per dirlo serve NOMINARE quello slug.
 *
 * Il server lo nomina fra virgolette nel messaggio (l'unico posto in cui viaggia:
 * il body dell'errore è `{code, message}`). Se l'estrazione non riesce si
 * degrada al percorso normale, che mostra comunque il messaggio del server.
 */
function creationErrorMessage(error: unknown, t: TFunction): string | null {
  if (error === null || error === undefined) return null;
  if (error instanceof ApiError && error.code === "plugin_slug_taken") {
    const slug = /"([^"]+)"/.exec(error.message)?.[1];
    if (slug) return t("settings:plugins.slugTaken", { slug });
  }
  return translateApiError(error, t);
}

/**
 * Form di registrazione: URL sorgente, ref da pinnare e sottocartella
 * opzionale. La subdir vuota NON viaggia (il campo è opzionale nello schema
 * condiviso, e una stringa vuota sarebbe un 400).
 */
function NewPluginForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [sourceUrl, setSourceUrl] = useState("");
  const [ref, setRef] = useState("");
  const [sourceSubdir, setSourceSubdir] = useState("");

  const mutation = useMutation({
    mutationFn: () => {
      const subdir = sourceSubdir.trim();
      return createPlugin({
        sourceUrl: sourceUrl.trim(),
        ref: ref.trim(),
        ...(subdir === "" ? {} : { sourceSubdir: subdir }),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: pluginsQueryOptions.queryKey });
      onDone();
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <TextField
        id="new-plugin-source-url"
        label={t("settings:plugins.sourceUrl")}
        required
        placeholder={t("settings:plugins.sourceUrlPlaceholder")}
        value={sourceUrl}
        onChange={(event) => setSourceUrl(event.target.value)}
      />
      <TextField
        id="new-plugin-ref"
        label={t("settings:plugins.ref")}
        required
        placeholder={t("settings:plugins.refPlaceholder")}
        value={ref}
        onChange={(event) => setRef(event.target.value)}
      />
      <div className="flex flex-col gap-1.5">
        <TextField
          id="new-plugin-subdir"
          label={t("settings:plugins.sourceSubdir")}
          placeholder={t("settings:plugins.sourceSubdirPlaceholder")}
          value={sourceSubdir}
          onChange={(event) => setSourceSubdir(event.target.value)}
        />
        <p className="font-mono text-[11px] text-fg-faint">{t("settings:plugins.addHint")}</p>
      </div>

      <FormError message={creationErrorMessage(mutation.error, t)} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={mutation.isPending}>
          {mutation.isPending ? t("settings:plugins.creating") : t("settings:plugins.create")}
        </SubmitButton>
        <button
          type="button"
          onClick={onDone}
          className="rounded-sm px-3 py-2 font-mono text-[12px] font-medium tracking-[0.08em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
        >
          {t("common:cancel")}
        </button>
      </div>
    </form>
  );
}

/**
 * Riga di un plugin: identità, badge, errori, diff dell'inventario dopo un
 * aggiornamento, inventario espandibile e azioni.
 *
 * Le azioni che accodano un job sono disabilitate quando ce n'è già uno in volo
 * (`pendingJobKind`): il server risponderebbe 409 `plugin_job_pending`, e non
 * si offre un bottone che si sa già che fallisce. Lo smoke, in più, richiede una
 * revisione materializzata (altrimenti 409 `plugin_not_ready`).
 */
function PluginRow({ plugin }: { plugin: Plugin }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [updating, setUpdating] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: pluginsQueryOptions.queryKey });

  const update = useMutation({
    mutationFn: (ref: string) => updatePluginRef(plugin.id, ref),
    onSuccess: async () => {
      await invalidate();
      setUpdating(false);
    },
  });
  const smoke = useMutation({
    mutationFn: () => smokePlugin(plugin.id),
    onSuccess: invalidate,
  });
  const deletion = useMutation({
    mutationFn: () => deletePlugin(plugin.id),
    onSuccess: invalidate,
  });

  const diff = useInventoryDiff(plugin);

  const jobPending = plugin.pendingJobKind !== null;
  const busy = update.isPending || smoke.isPending || deletion.isPending;
  const actionError = [update.error, smoke.error, deletion.error].find((e) => e !== null);

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[14px] font-medium text-fg">{plugin.name}</span>
        <StatusBadge status={plugin.status} />
        <SmokeBadge status={plugin.smokeStatus} />
        <span className="font-mono text-[11px] whitespace-nowrap text-fg-faint">
          {t("settings:plugins.refValue", { ref: plugin.ref })}
        </span>
        <span className="font-mono text-[11px] whitespace-nowrap text-fg-faint">
          {plugin.resolvedSha
            ? t("settings:plugins.pin", { sha: plugin.resolvedSha.slice(0, 12) })
            : t("settings:plugins.notMaterialized")}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!updating && (
            <RowButton
              onClick={() => setUpdating(true)}
              disabled={busy || jobPending}
              label={t("settings:plugins.update")}
            />
          )}
          <RowButton
            onClick={() => smoke.mutate()}
            disabled={busy || jobPending || plugin.status !== "ready"}
            label={t("settings:plugins.retrySmoke")}
          />
          {confirmingDelete ? (
            <>
              <RowButton
                onClick={() => deletion.mutate()}
                disabled={busy}
                label={t("settings:plugins.confirm")}
                danger
              />
              <RowButton onClick={() => setConfirmingDelete(false)} label={t("common:cancel")} />
            </>
          ) : (
            <RowButton
              onClick={() => setConfirmingDelete(true)}
              disabled={busy}
              label={t("settings:plugins.remove")}
              danger
            />
          )}
        </div>
      </div>

      <p className="mt-1 font-mono text-[11px] break-all text-fg-faint">
        {plugin.sourceUrl}
        {plugin.sourceSubdir !== null && ` · ${plugin.sourceSubdir}`}
      </p>

      {updating && (
        <UpdateRefForm
          plugin={plugin}
          pending={update.isPending}
          onSubmit={(ref) => update.mutate(ref)}
          onCancel={() => setUpdating(false)}
        />
      )}

      {actionError !== undefined && (
        <p role="alert" className="mt-2 font-mono text-[12px] text-danger">
          {translateApiError(actionError, t)}
        </p>
      )}

      {plugin.error !== null && (
        <p role="alert" className="mt-2 font-mono text-[12px] leading-relaxed text-danger">
          {t("settings:plugins.materializeError")}: {plugin.error}
        </p>
      )}

      {plugin.smokeStatus === "failed" && plugin.smokeError !== null && (
        <p role="alert" className="mt-2 font-mono text-[12px] leading-relaxed text-danger">
          {t("settings:plugins.smokeErrorLabel")}: {plugin.smokeError}
        </p>
      )}

      {diff && <InventoryDiffNote diff={diff} />}

      <div className="mt-2">
        {plugin.inventory === null ? (
          <p className="font-mono text-[11px] text-fg-faint">{t("settings:plugins.noInventory")}</p>
        ) : (
          <CollapsibleSection
            title={t("settings:plugins.inventory")}
            meta={t("settings:plugins.inventoryMeta", {
              skills: plugin.inventory.skills.length,
              commands: plugin.inventory.commands.length,
              agents: plugin.inventory.agents.length,
              hooks: plugin.inventory.hooks.length,
            })}
          >
            <InventoryPanel inventory={plugin.inventory} />
          </CollapsibleSection>
        )}
      </div>
    </li>
  );
}

/** Form inline del cambio ref: parte dal ref corrente, che è quasi sempre la base. */
function UpdateRefForm({
  plugin,
  pending,
  onSubmit,
  onCancel,
}: {
  plugin: Plugin;
  pending: boolean;
  onSubmit: (ref: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [ref, setRef] = useState(plugin.ref);

  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-3 border-l-2 border-line pl-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(ref.trim());
      }}
    >
      <TextField
        id={`plugin-${plugin.id}-ref`}
        label={t("settings:plugins.updateRef")}
        required
        value={ref}
        onChange={(event) => setRef(event.target.value)}
      />
      <div className="flex items-center gap-2 pb-1">
        <RowButton
          type="submit"
          disabled={pending || ref.trim() === ""}
          label={t("settings:plugins.updateSubmit")}
        />
        <RowButton onClick={onCancel} label={t("common:cancel")} />
      </div>
    </form>
  );
}

/** Contenuto dell'inventario: cosa il plugin porta dentro un run dell'agente. */
function InventoryPanel({ inventory }: { inventory: PluginInventory }) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3">
      <InventoryGroup title={t("settings:plugins.skills")} empty={inventory.skills.length === 0}>
        {inventory.skills.map((skill) => (
          <li key={skill.name} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-[12px] text-fg">{skill.name}</span>
            <span className="font-mono text-[11px] text-fg-faint">
              {t("settings:plugins.skillSize", { kb: (skill.bytes / 1024).toFixed(1) })}
            </span>
            {skill.description !== undefined && (
              <span className="text-[12px] text-fg-muted">{skill.description}</span>
            )}
          </li>
        ))}
      </InventoryGroup>

      <InventoryGroup
        title={t("settings:plugins.commands")}
        empty={inventory.commands.length === 0}
      >
        {inventory.commands.map((command) => (
          <li key={command.name} className="font-mono text-[12px] text-fg">
            {command.name}
          </li>
        ))}
      </InventoryGroup>

      <InventoryGroup title={t("settings:plugins.agents")} empty={inventory.agents.length === 0}>
        {inventory.agents.map((agent) => (
          <li key={agent.name} className="font-mono text-[12px] text-fg">
            {agent.name}
          </li>
        ))}
      </InventoryGroup>

      {/* Un hook è codice che gira a ogni run: il comando si legge in chiaro,
          non si riassume. */}
      <InventoryGroup title={t("settings:plugins.hooks")} empty={inventory.hooks.length === 0}>
        {inventory.hooks.map((hook) => (
          <li key={hook.key} className="flex flex-col gap-0.5">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-[12px] text-fg">{hook.event}</span>
              {hook.matcher !== undefined && (
                <span className="font-mono text-[11px] text-fg-faint">
                  {t("settings:plugins.hookMatcher", { matcher: hook.matcher })}
                </span>
              )}
            </span>
            <span className="rounded-sm border border-line bg-ink-950/70 px-2 py-1 font-mono text-[11px] break-all text-fg-muted">
              {hook.command}
            </span>
          </li>
        ))}
      </InventoryGroup>

      {inventory.hasMcp && (
        <p className="font-mono text-[11px] text-fg-faint">{t("settings:plugins.mcpPresent")}</p>
      )}
    </div>
  );
}

/** Gruppo dell'inventario con titolo mono e vuoto esplicito. */
function InventoryGroup({
  title,
  empty,
  children,
}: {
  title: string;
  empty: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">
        {title}
      </span>
      {empty ? (
        <p className="font-mono text-[11px] text-fg-faint">{t("settings:plugins.emptyList")}</p>
      ) : (
        <ul className="flex flex-col gap-1">{children}</ul>
      )}
    </div>
  );
}

/** Cosa è cambiato nell'inventario fra due revisioni materializzate. */
export interface InventoryDiff {
  skillsAdded: string[];
  skillsRemoved: string[];
  skillsChanged: string[];
  hooksAdded: string[];
  hooksRemoved: string[];
  hooksChanged: string[];
}

/**
 * Confronto fra l'inventario precedente e quello nuovo. Ritorna `null` quando
 * non c'è nulla da dire: manca un lato del confronto (un plugin mai
 * materializzato prima, o un inventario illeggibile) oppure niente è cambiato.
 *
 * "Cambiata" per una skill è una differenza di descrizione o di dimensione del
 * SKILL.md; per un hook una differenza di evento, matcher o comando — cioè di
 * ciò che effettivamente gira.
 */
export function diffInventories(
  previous: PluginInventory | null,
  next: PluginInventory | null,
): InventoryDiff | null {
  if (previous === null || next === null) return null;

  const previousSkills = new Map(previous.skills.map((s) => [s.name, s]));
  const nextSkills = new Map(next.skills.map((s) => [s.name, s]));
  const previousHooks = new Map(previous.hooks.map((h) => [h.key, h]));
  const nextHooks = new Map(next.hooks.map((h) => [h.key, h]));

  const diff: InventoryDiff = {
    skillsAdded: [...nextSkills.keys()].filter((name) => !previousSkills.has(name)),
    skillsRemoved: [...previousSkills.keys()].filter((name) => !nextSkills.has(name)),
    skillsChanged: [...nextSkills.entries()]
      .filter(([name, skill]) => {
        const before = previousSkills.get(name);
        return (
          before !== undefined &&
          (before.bytes !== skill.bytes || before.description !== skill.description)
        );
      })
      .map(([name]) => name),
    hooksAdded: [...nextHooks.keys()].filter((key) => !previousHooks.has(key)),
    hooksRemoved: [...previousHooks.keys()].filter((key) => !nextHooks.has(key)),
    hooksChanged: [...nextHooks.entries()]
      .filter(([key, hook]) => {
        const before = previousHooks.get(key);
        return (
          before !== undefined &&
          (before.event !== hook.event ||
            before.matcher !== hook.matcher ||
            before.command !== hook.command)
        );
      })
      .map(([key]) => key),
  };

  return Object.values(diff).some((list) => list.length > 0) ? diff : null;
}

/**
 * Diff dell'inventario calcolato quando `resolvedSha` cambia SOTTO GLI OCCHI di
 * chi guarda: il termine di paragone è la revisione che questa riga stava già
 * mostrando, tenuta in un ref. È una cortesia dopo un aggiornamento — al primo
 * render non c'è nulla da confrontare, e la storia non viene ricostruita.
 */
function useInventoryDiff(plugin: Plugin): InventoryDiff | null {
  const shown = useRef({ sha: plugin.resolvedSha, inventory: plugin.inventory });
  const [diff, setDiff] = useState<InventoryDiff | null>(null);

  useEffect(() => {
    if (plugin.resolvedSha === shown.current.sha) return;
    setDiff(diffInventories(shown.current.inventory, plugin.inventory));
    shown.current = { sha: plugin.resolvedSha, inventory: plugin.inventory };
  }, [plugin.resolvedSha, plugin.inventory]);

  return diff;
}

/** Le righe del diff, omesse quando la loro lista è vuota. */
function InventoryDiffNote({ diff }: { diff: InventoryDiff }) {
  const { t } = useTranslation();
  const lines: [keyof InventoryDiff, string][] = [
    ["skillsAdded", "settings:plugins.diffSkillsAdded"],
    ["skillsRemoved", "settings:plugins.diffSkillsRemoved"],
    ["skillsChanged", "settings:plugins.diffSkillsChanged"],
    ["hooksAdded", "settings:plugins.diffHooksAdded"],
    ["hooksRemoved", "settings:plugins.diffHooksRemoved"],
    ["hooksChanged", "settings:plugins.diffHooksChanged"],
  ];

  return (
    <div className="mt-2 rounded-sm border border-line bg-ink-950/70 px-3 py-2">
      <p className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">
        {t("settings:plugins.diffTitle")}
      </p>
      {lines.map(([key, label]) =>
        diff[key].length === 0 ? null : (
          <p key={key} className="mt-1 font-mono text-[11px] text-fg-muted">
            {t(label, { items: diff[key].join(", ") })}
          </p>
        ),
      )}
    </div>
  );
}

/**
 * Badge della materializzazione. `none` NON è uno stato di quiete: fra la
 * registrazione e il claim del worker un plugin resta lì, e mostrarlo come
 * "nessuno stato" farebbe sembrare rotto qualcosa che sta solo aspettando.
 */
function StatusBadge({ status }: { status: Plugin["status"] }) {
  const { t } = useTranslation();
  const map = {
    none: { key: "statusNone", cls: "border-line-strong text-fg-faint" },
    materializing: { key: "statusMaterializing", cls: "border-line-strong text-fg-muted" },
    ready: { key: "statusReady", cls: "border-ok/40 text-ok" },
    failed: { key: "statusFailed", cls: "border-danger/40 text-danger" },
  } as const;
  const { key, cls } = map[status];

  return (
    <span
      className={`rounded-sm border px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] whitespace-nowrap uppercase ${cls}`}
    >
      {t(`settings:plugins.${key}`)}
    </span>
  );
}

/** Badge dello smoke run. `idle` non mostra nulla (mai eseguito, o resettato). */
function SmokeBadge({ status }: { status: Plugin["smokeStatus"] }) {
  const { t } = useTranslation();
  if (status === "idle") return null;

  const map = {
    pending: { text: t("settings:plugins.smokePending"), cls: "border-line-strong text-fg-faint" },
    passed: { text: `✓ ${t("settings:plugins.smokePassed")}`, cls: "border-ok/40 text-ok" },
    failed: {
      text: `✕ ${t("settings:plugins.smokeFailed")}`,
      cls: "border-danger/40 text-danger",
    },
  } as const;
  const { text, cls } = map[status];

  return (
    <span
      className={`rounded-sm border px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] whitespace-nowrap uppercase ${cls}`}
    >
      {text}
    </span>
  );
}

/** Bottone d'azione della riga, gemello di quello dei provider AI. */
function RowButton({
  onClick,
  label,
  disabled,
  danger,
  type = "button",
}: {
  onClick?: () => void;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-sm border bg-ink-950/70 px-3 py-1.5 font-mono text-[11px] font-medium tracking-[0.08em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        danger
          ? "border-danger/30 text-danger hover:border-danger/60"
          : "border-line-strong text-fg-muted hover:border-ink-700 hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}
