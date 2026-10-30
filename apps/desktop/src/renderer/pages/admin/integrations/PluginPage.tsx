import { Link, useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePlugin, useRemovePlugin, useRerunSmoke, type PluginView } from "../../../data/queries";
import { Dialog } from "../../../tasks-ui/Dialog";
import { MenuNote, itemClass } from "../../../tasks-ui/Menu";
import { useToast } from "../../../tasks-ui/Toast";
import { ErrorLine } from "../../entry/parts";
import { ReadError, RowMenu, refusalOf } from "../../preferences/parts";
import { dangerSolidButton, secondaryButton } from "../../tasks/controls";
import { CrossGlyph, Dot, QuietNote, useRefusalWords } from "./parts";
import {
  NextOutcomeBox,
  PluginStatusWords,
  SmokeWords,
  shortSha,
  useReadyAnnouncement,
} from "./PluginsPage";
import { UpdateRefDialog } from "./RegisterPluginDialog";

// La pagina di un plugin (`/admin/plugins/$pluginId`, shape
// admin-integrations.md): la testata con indirizzo, ref, commit e chi l'ha
// registrato, stato e smoke test come nella riga; «Update to ref…» e il «⋯»
// (rifare lo smoke test, rimuovere); se non è riuscito, l'errore del worker
// in parole; poi l'inventario intero (skill con la frase, hook col
// comando). Finché un passo è in corso la pagina si rilegge da sola
// (`usePlugin`); aggiornare e rifare lo smoke aspettano che finisca (`busy`,
// dal livello dati).

export function PluginPage({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation();
  const plugin = usePlugin(pluginId);
  const announcement = useReadyAnnouncement(plugin.data ? [plugin.data] : undefined);

  return (
    <section className="page-header pb-16 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <div className="max-w-[880px]">
        <Link
          to="/admin/$section"
          params={{ section: "plugins" }}
          data-back-link
          className="inline-flex items-center gap-1 rounded-sm text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:text-ink"
        >
          <span aria-hidden="true">←</span>
          <span>{t("admin.plugins.page.back")}</span>
        </Link>
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
        {plugin.isPending ? (
          <PageSkeleton />
        ) : plugin.isError ? (
          (plugin.error as Error).message === "not_found" ? (
            <p className="mt-4 text-md text-ink">{t("admin.plugins.page.notFound")}</p>
          ) : (
            <ReadError
              message={t("admin.plugins.page.loadError")}
              onRetry={() => void plugin.refetch()}
            />
          )
        ) : (
          <PluginBody plugin={plugin.data} />
        )}
      </div>
    </section>
  );
}

function PluginBody({ plugin: p }: { plugin: PluginView }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const rerun = useRerunSmoke();
  const refusalWords = useRefusalWords();
  const [dialog, setDialog] = useState<"update" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const address = p.url.replace(/^https:\/\//, "") + (p.subdir ? `/${p.subdir}` : "");
  // La regola è del livello dati (`busy`): un passo in corso fa aspettare.
  const waitWords = p.busy ? t("admin.plugins.page.busy") : null;
  const smokeUnavailable = waitWords ?? (p.status !== "ready" ? t("admin.plugins.page.notReady") : null);

  async function runSmoke() {
    setError(null);
    const result = await rerun.mutateAsync(p.id).catch(() => null);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (!refusal) return;
    if (refusal.error === "conflict") return setError(t("admin.plugins.page.busy"));
    if (refusal.error === "invalid") return setError(t("admin.plugins.page.notReady"));
    setError(refusalWords(refusal.error) || null);
  }

  return (
    <>
      <div className="mt-3 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold tracking-[-0.01em] text-ink" title={p.name}>
            {p.name}
          </h1>
          {/* Va a capo fra le parti, mai dentro un nome (l'indirizzo, se lungo, sì). */}
          <p className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-ink-muted">
            {[
              address,
              t("admin.plugins.ref", { ref: p.ref }),
              ...(p.sha ? [t("admin.plugins.pin", { sha: shortSha(p.sha) })] : []),
              ...(p.registeredByName
                ? [t("admin.plugins.page.registeredBy", { name: p.registeredByName })]
                : []),
            ].map((part, i) => (
              <span key={i} className={`flex min-w-0 items-center gap-x-1.5 ${i === 0 ? "[overflow-wrap:anywhere]" : "whitespace-nowrap"}`}>
                {i > 0 && <Dot />}
                <span className={i === 2 && p.sha ? "num" : undefined}>{part}</span>
              </span>
            ))}
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <PluginStatusWords status={p.status} />
            <SmokeWords smoke={p.smoke} />
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-2 pt-1">
          <button
            type="button"
            disabled={p.busy}
            title={waitWords ?? undefined}
            onClick={() => setDialog("update")}
            className={`${secondaryButton} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {t("admin.plugins.page.updateRef")}
          </button>
          <RowMenu label={t("admin.plugins.page.menu", { name: p.name })}>
            {(close) => (
              <>
                <MenuItem
                  disabled={smokeUnavailable !== null}
                  onSelect={() => (close(true), void runSmoke())}
                >
                  {t("admin.plugins.page.rerun")}
                </MenuItem>
                {smokeUnavailable && <MenuNote>{smokeUnavailable}</MenuNote>}
                <MenuItem onSelect={() => (close(false), setDialog("remove"))}>
                  {t("admin.plugins.page.remove")}
                </MenuItem>
              </>
            )}
          </RowMenu>
        </span>
      </div>
      {/* Spento mentre si prepara: la frase sotto, non solo nel `title`. */}
      {waitWords && <p className="mt-2 text-right text-xs text-ink-muted">{waitWords}</p>}
      {error && (
        <div className="mt-2">
          <ErrorLine>{error}</ErrorLine>
        </div>
      )}

      {p.status === "failed" && p.error && (
        <div className="mt-5 flex items-start gap-2.5 rounded-md border border-rule-strong px-3.5 py-3">
          <span className="mt-[3px] shrink-0 text-critical">
            <CrossGlyph size={14} />
          </span>
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-md font-semibold text-critical">
              {t("admin.plugins.page.failedTitle", { name: p.name })}
            </p>
            {/* Il testo del worker: in codice se è un log (più righe). */}
            {p.error.includes("\n") ? (
              <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap text-ink">
                {p.error}
              </pre>
            ) : (
              <p className="text-md text-pretty text-ink">{p.error}</p>
            )}
            <p className="text-sm text-ink-muted">{t("admin.plugins.page.failedHint")}</p>
          </div>
        </div>
      )}

      <Inventory plugin={p} />
      <NextOutcomeBox />

      {dialog === "update" && <UpdateRefDialog plugin={p} onClose={() => setDialog(null)} />}
      {dialog === "remove" && (
        <RemoveDialog
          plugin={p}
          onClose={() => setDialog(null)}
          onRemoved={() => {
            toast.show(t("admin.plugins.removeDialog.done", { name: p.name }));
            void navigate({ to: "/admin/$section", params: { section: "plugins" } });
          }}
        />
      )}
    </>
  );
}

/** L'inventario: le skill con la loro frase, gli hook col comando, le due note. */
function Inventory({ plugin: p }: { plugin: PluginView }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="plugin-inventory" className="mt-8">
      <h2 id="plugin-inventory" className="text-lg font-semibold text-ink">
        {t("admin.plugins.page.inventory")}
      </h2>
      {!p.inventory ? (
        <p className="mt-3 border-t border-rule pt-4 text-md text-ink-muted">
          {t("admin.plugins.page.noInventory")}
        </p>
      ) : (
        <>
          <GroupHeading label={t("admin.plugins.page.skills")} count={p.inventory.skills.length} />
          <ul aria-label={t("admin.plugins.page.skills")} className="border-t border-rule">
            {p.inventory.skills.map((s) => (
              <SkillRow key={s.name} name={s.name} description={s.description} />
            ))}
          </ul>
          <GroupHeading label={t("admin.plugins.page.hooks")} count={p.inventory.hooks.length} />
          <ul aria-label={t("admin.plugins.page.hooks")} className="@container border-t border-rule">
            {p.inventory.hooks.map((h) => (
              <li
                key={h.key}
                className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 border-b border-rule py-2.5 @max-[719px]:grid-cols-[auto_minmax(0,1fr)]"
              >
                <span className="num text-sm font-semibold text-ink">{h.key}</span>
                <span className="text-sm text-ink-muted">{h.event}</span>
                <code
                  title={h.command}
                  className="block min-w-0 truncate rounded-sm bg-ink/5 px-2 py-1 font-mono text-xs text-ink @max-[719px]:col-span-2"
                >
                  {h.command}
                </code>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="mt-4 flex flex-col gap-1.5">
        <QuietNote size="xs">{t("admin.plugins.page.mcpNote")}</QuietNote>
        <p className="text-xs text-ink-muted">{t("admin.plugins.page.projectsNote")}</p>
      </div>
    </section>
  );
}

function GroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <p className="mt-5 flex items-baseline gap-2 pb-1.5">
      <span className="heading-group">{label}</span>
      <span className="num text-xs text-ink-faint">{count}</span>
    </p>
  );
}

/** Una skill: nome e la sua frase su due righe al più, con «More» se ne serve di più. */
function SkillRow({ name, description }: { name: string; description: string }) {
  const { t } = useTranslation();
  const text = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = text.current;
    if (el && !open) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [description, open]);
  return (
    <li className="flex flex-col gap-0.5 border-b border-rule py-2.5">
      <span className="text-md font-semibold text-ink">{name}</span>
      <p ref={text} className={`max-w-[72ch] text-sm text-pretty text-ink-muted ${open ? "" : "line-clamp-2"}`}>
        {description}
      </p>
      {(overflows || open) && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="w-fit rounded-sm text-xs font-medium text-ink underline-offset-4 hover:underline"
        >
          {open ? t("admin.plugins.page.less") : t("admin.plugins.page.more")}
        </button>
      )}
    </li>
  );
}

/** Una voce del «⋯»; spenta resta raggiungibile con le frecce. */
function MenuItem({
  children,
  disabled = false,
  onSelect,
}: {
  children: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onSelect();
      }}
      className={`${itemClass} ${disabled ? "cursor-not-allowed text-ink-faint hover:bg-transparent" : ""}`}
    >
      {children}
    </button>
  );
}

/** «Remove…» (440 px): nessuna riconferma, non esegue codice né tocca un segreto. */
function RemoveDialog({
  plugin: p,
  onClose,
  onRemoved,
}: {
  plugin: PluginView;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const { t } = useTranslation();
  const remove = useRemovePlugin();
  const refusalWords = useRefusalWords();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    const result = await remove.mutateAsync(p.id).catch(() => null);
    setBusy(false);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal) return setError(refusalWords(refusal.error) || null);
    onClose();
    onRemoved();
  }

  return (
    <Dialog
      title={t("admin.plugins.removeDialog.title", { name: p.name })}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("admin.integrations.cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            className={`${dangerSolidButton} disabled:opacity-40`}
            onClick={() => void submit()}
          >
            {t("admin.plugins.removeDialog.submit")}
          </button>
        </>
      }
    >
      <p className="text-md text-pretty text-ink">{t("admin.plugins.removeDialog.body")}</p>
      {error && <ErrorLine>{error}</ErrorLine>}
    </Dialog>
  );
}

/** La testata e sei righe, alte quanto le vere. */
function PageSkeleton() {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe mt-3">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      <span className={`block h-6 w-48 ${bar}`} />
      <span className={`mt-3 block h-3 w-80 ${bar}`} />
      <div className="mt-8 border-t border-rule">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex h-14 items-center border-b border-rule">
            <span className={`h-2.5 ${bar}`} style={{ width: `${30 + ((i * 11) % 30)}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}
