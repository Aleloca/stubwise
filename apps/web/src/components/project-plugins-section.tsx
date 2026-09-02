import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  ApiError,
  putProjectPlugins,
  type Plugin,
  type PluginInventory,
  type PluginRecommendations,
  type ProjectPlugin,
} from "../lib/api";
import { pluginsQueryOptions, projectPluginsQueryOptions } from "../lib/queries";
import { translateApiError } from "../lib/translate-api-error";
import { HookCommand, InventoryGroup } from "./plugin-inventory";
import { RowButton } from "./row-button";

/**
 * Sezione "Plugin" del dettaglio progetto (solo admin): quali plugin del
 * registro d'istanza entrano nei run dell'agente di QUESTO progetto e quali
 * loro skill/hook spegnerci.
 *
 * Sezione SECONDARIA: `useQuery` (non suspense) e loading/errore inline, così
 * un suo fallimento degrada solo qui e NON abbatte il resto della pagina
 * progetto (pattern di {@link ProjectServersSection}).
 *
 * SALVATAGGIO IMMEDIATO: ogni interruttore e ogni casella manda subito un PUT
 * con l'INSIEME COMPLETO delle abilitazioni del progetto. Il body si costruisce
 * SEMPRE dalla foto del server tenuta in cache (mai da uno stato locale del
 * form): il PUT è una sostituzione completa, e un body nato da uno stato
 * stantio cancellerebbe le abilitazioni fatte da qualcun altro.
 */
export function ProjectPluginsSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const registry = useQuery(pluginsQueryOptions);
  const enabled = useQuery(projectPluginsQueryOptions(projectId));
  const projectPluginsKey = projectPluginsQueryOptions(projectId).queryKey;

  const save = useMutation({
    mutationFn: (plugins: ProjectPlugin[]) => putProjectPlugins(projectId, plugins),
    onMutate: async (plugins) => {
      // Ottimistico: il click si vede subito. La FOTO DEL SERVER da cui il body
      // è nato resta in `previous`, ed è quella a cui si torna su errore.
      await queryClient.cancelQueries({ queryKey: projectPluginsKey });
      const previous = queryClient.getQueryData(projectPluginsKey);
      queryClient.setQueryData(projectPluginsKey, { plugins });
      return { previous };
    },
    onSuccess: (data) => queryClient.setQueryData(projectPluginsKey, data),
    onError: (error, _plugins, context) => {
      if (context?.previous) queryClient.setQueryData(projectPluginsKey, context.previous);
      // Un 400 sul contenuto del body dice che la nostra copia del registro è
      // vecchia: si ricarica e si lascia che il form si ricostruisca
      // dall'inventario fresco. NESSUN retry che tolga la voce sconosciuta —
      // scarterebbe in silenzio uno spegnimento voluto, cioè esattamente ciò
      // che questo 400 esiste per impedire.
      if (isStaleRegistryError(error)) {
        void queryClient.invalidateQueries({ queryKey: pluginsQueryOptions.queryKey });
        void queryClient.invalidateQueries({ queryKey: projectPluginsKey });
      }
    },
  });

  if (registry.isPending || enabled.isPending) {
    return (
      <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">
        {t("projects:plugins.loading")}
      </p>
    );
  }

  if (registry.isError || enabled.isError) {
    return (
      <div className="rounded-sm border border-danger/30 bg-danger/10 px-4 py-3">
        <p className="font-mono text-[12px] text-danger">{t("projects:plugins.error")}</p>
      </div>
    );
  }

  const rows = enabled.data.plugins;

  return (
    <div className="flex flex-col gap-3">
      {/*
        Cambio di comportamento osservabile, da sapere PRIMA di accendere un
        plugin: i run coi plugin passano `--setting-sources ""`. Nei run di fix
        la cwd è comunque la parent dir dei worktree (quelle impostazioni non
        erano mai state caricate), nel deep dive e nella chat di analisi la cwd
        è la radice del worktree — lì vengono davvero disattivate.
      */}
      <p className="rounded-sm border border-line-strong bg-ink-900 px-4 py-3 font-mono text-[11px] leading-relaxed text-fg-muted">
        {t("projects:plugins.settingSourcesWarning")}
      </p>

      {registry.data.plugins.length === 0 ? (
        <div className="grid place-items-center rounded-sm border border-dashed border-line-strong py-12">
          <p className="font-mono text-[12px] tracking-[0.18em] text-fg-faint uppercase">
            {t("projects:plugins.empty")}
          </p>
          <p className="mt-2 max-w-md text-center text-sm text-fg-muted">
            {t("projects:plugins.emptyHint")}{" "}
            <Link to="/settings/plugins" className="text-signal underline-offset-2 hover:underline">
              {t("projects:plugins.manage")}
            </Link>
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-sm border border-line bg-ink-900">
          {registry.data.plugins.map((plugin) => (
            <PluginRow
              key={plugin.id}
              plugin={plugin}
              row={rowOf(rows, plugin.id)}
              recommendations={registry.data.recommendations}
              saving={save.isPending}
              onChange={(next) => save.mutate(withRow(rows, next))}
            />
          ))}
        </ul>
      )}

      {save.isPending && (
        <p className="font-mono text-[11px] text-fg-faint">{t("projects:plugins.saving")}</p>
      )}
      {save.isError && (
        <p role="alert" className="font-mono text-[12px] leading-relaxed text-danger">
          {saveErrorMessage(save.error, t)}
        </p>
      )}
    </div>
  );
}

/** I tre 400 del PUT che dicono "la tua copia del registro è vecchia". */
function isStaleRegistryError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "unknown_plugin" ||
      error.code === "unknown_plugin_skill" ||
      error.code === "unknown_plugin_hook")
  );
}

/**
 * Messaggio del salvataggio fallito. I 400 sul contenuto non si traducono col
 * `code`: chi legge non deve sapere che "una skill non esiste", deve sapere che
 * l'inventario è cambiato sotto e che la selezione va ricontrollata.
 */
function saveErrorMessage(error: unknown, t: TFunction): string {
  if (error instanceof ApiError) {
    if (error.code === "unknown_plugin_skill" || error.code === "unknown_plugin_hook") {
      return t("projects:plugins.inventoryChanged");
    }
    if (error.code === "unknown_plugin") return t("projects:plugins.registryChanged");
  }
  return translateApiError(error, t);
}

/** Riga del plugin nella foto del server, o la riga neutra se non c'è. */
function rowOf(rows: ProjectPlugin[], pluginId: string): ProjectPlugin {
  return (
    rows.find((row) => row.pluginId === pluginId) ?? {
      pluginId,
      enabled: false,
      disabledSkills: [],
      disabledHooks: [],
    }
  );
}

/**
 * L'insieme completo con la riga di un plugin sostituita (o aggiunta in coda).
 *
 * Le altre righe passano INTATTE, comprese quelle dei plugin disabilitati: una
 * riga `enabled: false` conserva gli spegnimenti, ometterla li perde.
 */
function withRow(rows: ProjectPlugin[], next: ProjectPlugin): ProjectPlugin[] {
  return rows.some((row) => row.pluginId === next.pluginId)
    ? rows.map((row) => (row.pluginId === next.pluginId ? next : row))
    : [...rows, next];
}

/**
 * Skill del preset consigliato che ESISTONO DAVVERO nell'inventario di questa
 * revisione del plugin.
 *
 * L'intersezione non è una cortesia: le raccomandazioni sono una costante
 * chiavata sul `name` del manifest e cablata a un elenco di skill, mentre
 * l'inventario è ciò che quella revisione contiene per davvero. Mandare una
 * skill che il plugin non ha più farebbe fallire l'intero salvataggio con un
 * 400 `unknown_plugin_skill`.
 */
export function presetSkills(
  inventory: PluginInventory | null,
  recommendations: PluginRecommendations,
): string[] {
  if (inventory === null) return [];
  const recommended = recommendations[inventory.name];
  if (recommended === undefined) return [];
  const available = new Set(inventory.skills.map((skill) => skill.name));
  return recommended.filter((name) => available.has(name));
}

/**
 * Riga di un plugin: interruttore di abilitazione e, quando è abilitato su un
 * plugin materializzato, le caselle di skill e hook.
 *
 * L'interruttore c'è anche sui plugin senza revisione materializzata (con
 * l'avviso che non entreranno comunque nei run): serve a poterli disabilitare —
 * finché un plugin è abilitato da qualche parte il registro rifiuta di
 * rimuoverlo (409 `plugin_in_use`). Le caselle no: senza inventario non c'è
 * nulla da spegnere, e il server rifiuterebbe qualunque spegnimento.
 */
function PluginRow({
  plugin,
  row,
  recommendations,
  saving,
  onChange,
}: {
  plugin: Plugin;
  row: ProjectPlugin;
  recommendations: PluginRecommendations;
  saving: boolean;
  onChange: (next: ProjectPlugin) => void;
}) {
  const { t } = useTranslation();
  const inventory = plugin.status === "ready" ? plugin.inventory : null;
  const preset = presetSkills(inventory, recommendations);
  const presetLeft = preset.filter((name) => !row.disabledSkills.includes(name));

  /** Accende/spegne una voce nella lista degli spegnimenti (checked = gira). */
  function toggleDisabled(field: "disabledSkills" | "disabledHooks", key: string, on: boolean) {
    const current = row[field];
    onChange({
      ...row,
      [field]: on ? current.filter((k) => k !== key) : [...current, key],
    });
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2.5">
          <input
            type="checkbox"
            checked={row.enabled}
            disabled={saving}
            onChange={(event) => onChange({ ...row, enabled: event.target.checked })}
            className="h-4 w-4 shrink-0 accent-signal"
          />
          <span className="text-[14px] font-medium text-fg">{plugin.name}</span>
          <span className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">
            {t("projects:plugins.enabled")}
          </span>
        </label>
        <span className="font-mono text-[11px] whitespace-nowrap text-fg-faint">
          {t("projects:plugins.refValue", { ref: plugin.ref })}
        </span>
      </div>

      {inventory === null ? (
        <p className="mt-1 font-mono text-[11px] text-fg-faint">{t("projects:plugins.notReady")}</p>
      ) : (
        row.enabled && (
          <div className="mt-3 flex flex-col gap-3 border-l-2 border-line pl-3">
            <div className="flex flex-wrap items-center gap-3">
              <p className="font-mono text-[11px] text-fg-faint">
                {t("projects:plugins.selectionHint")}
              </p>
              {preset.length > 0 && (
                <>
                  <RowButton
                    label={t("projects:plugins.applyPreset")}
                    disabled={saving || presetLeft.length === 0}
                    onClick={() =>
                      onChange({
                        ...row,
                        // Unione, non sostituzione: il preset AGGIUNGE i suoi
                        // spegnimenti senza riaccendere ciò che l'admin ha
                        // spento a mano.
                        disabledSkills: [...row.disabledSkills, ...presetLeft],
                      })
                    }
                  />
                  {presetLeft.length === 0 && (
                    <span className="font-mono text-[11px] text-fg-faint">
                      {t("projects:plugins.presetApplied")}
                    </span>
                  )}
                </>
              )}
            </div>

            <InventoryGroup
              title={t("projects:plugins.skills")}
              empty={inventory.skills.length === 0}
            >
              {inventory.skills.map((skill) => (
                <li key={skill.name}>
                  <label className="flex flex-wrap items-baseline gap-x-2">
                    <input
                      type="checkbox"
                      checked={!row.disabledSkills.includes(skill.name)}
                      disabled={saving}
                      onChange={(event) =>
                        toggleDisabled("disabledSkills", skill.name, event.target.checked)
                      }
                      className="h-4 w-4 shrink-0 self-center accent-signal"
                    />
                    <span className="font-mono text-[12px] text-fg">{skill.name}</span>
                    {skill.description !== undefined && (
                      <span className="text-[12px] text-fg-muted">{skill.description}</span>
                    )}
                  </label>
                </li>
              ))}
            </InventoryGroup>

            <InventoryGroup
              title={t("projects:plugins.hooks")}
              empty={inventory.hooks.length === 0}
            >
              {inventory.hooks.map((hook) => (
                <li key={hook.key} className="flex flex-col gap-0.5">
                  <label className="flex flex-wrap items-baseline gap-x-2">
                    <input
                      type="checkbox"
                      checked={!row.disabledHooks.includes(hook.key)}
                      disabled={saving}
                      onChange={(event) =>
                        toggleDisabled("disabledHooks", hook.key, event.target.checked)
                      }
                      className="h-4 w-4 shrink-0 self-center accent-signal"
                    />
                    <span className="font-mono text-[12px] text-fg">{hook.event}</span>
                    {hook.matcher !== undefined && (
                      <span className="font-mono text-[11px] text-fg-faint">
                        {t("projects:plugins.hookMatcher", { matcher: hook.matcher })}
                      </span>
                    )}
                  </label>
                  {/* Il comando accanto alla sua casella: qui il rischio lo si
                      accetta davvero, e non si spunta ciò che non si è letto. */}
                  <HookCommand command={hook.command} />
                </li>
              ))}
            </InventoryGroup>
          </div>
        )
      )}
    </li>
  );
}
