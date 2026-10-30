import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { SecretInput, maskedSecret } from "../../../components/SecretField";
import { now } from "../../../data/dates";
import {
  BACKGROUND_WEEKLY_THRESHOLD,
  useDeleteProvider,
  useMoveProvider,
  useProviders,
  useReplaceProviderCredential,
  useSetProviderEnabled,
  useSimulateNextTest,
  useTestProvider,
  type ProviderView,
  type TestOutcome,
} from "../../../data/queries";
import { useReauth } from "../../../layout/useReauth";
import { formatDate } from "../../../notifications/time";
import { Dialog } from "../../../tasks-ui/Dialog";
import { MenuNote, itemClass } from "../../../tasks-ui/Menu";
import { useToast } from "../../../tasks-ui/Toast";
import { PrototypeBox } from "../../automations/shared";
import { Segmented, selectClass } from "../../automations/builder/controls";
import { ErrorLine } from "../../entry/parts";
import { TriangleGlyph } from "../../preferences/glyphs";
import { ReadError, RowMenu, refusalOf } from "../../preferences/parts";
import { ago } from "../../releases/format";
import { CrossGlyph, MetaLine, QuietNote } from "../integrations/parts";
import { Switch } from "../../preferences/SubscriptionRow";
import { dangerSolidButton, primaryButton, secondaryButton } from "../../tasks/controls";
import { AddProviderDialog } from "./AddProviderDialog";
import { AiSkeleton, AiWhoCan, ReadOnlyLine, useAiRefusalWords } from "./parts";

// Providers (shape admin-ai.md «Providers»): la catena degli account con
// cui Claude lavora, l'unico elenco ORDINATO della pagina, numerato in cifre
// tabellari [AI 1]. Si riordina trascinando dalla maniglia, con Alt+↑/↓ o
// dal «⋯» [AI 4]: si salva subito e si annuncia. L'interruttore salva
// subito; l'ultimo acceso è spento con la sua frase (RF 4, dal livello dati:
// `lastEnabled`). Aggiungere, sostituire la chiave ed eliminare chiedono la
// riconferma. La chiave non torna mai: «•••• 7f3a».

/** Quanto dura «Testing…» almeno: una prova vera non è istantanea. */
const TEST_MS = 600;
/** Quanto resta evidenziata la riga appena aggiunta. */
const ADDED_MS = 2000;

const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export function ProvidersPanel({ canWrite }: { canWrite: boolean }) {
  const { t } = useTranslation();
  const providers = useProviders();
  const move = useMoveProvider();
  const refusalWords = useAiRefusalWords();
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<ProviderView | null>(null);
  const [deleting, setDeleting] = useState<ProviderView | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [moveError, setMoveError] = useState<string | null>(null);
  // L'ordine dopo un riordino, finché la catena non torna dal livello dati.
  const [order, setOrder] = useState<string[] | null>(null);
  const instructionsId = useId();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  useEffect(() => setOrder(null), [providers.data]);
  useEffect(() => {
    if (!added) return;
    const timer = window.setTimeout(() => setAdded(null), ADDED_MS);
    return () => window.clearTimeout(timer);
  }, [added]);

  const header = (
    <>
      <div className="flex items-start gap-4">
        <p className="min-w-0 flex-1 max-w-[62ch] text-md text-pretty text-ink">
          {t("admin.ai.providers.intro")}
        </p>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {!canWrite && <AiWhoCan scope="providers" />}
          <button
            type="button"
            disabled={!canWrite}
            onClick={() => setAdding(true)}
            className={`${primaryButton} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {t("admin.ai.providers.add")}
          </button>
        </span>
      </div>
      {!canWrite && (
        <div className="mt-3">
          <ReadOnlyLine scope="providers" />
        </div>
      )}
    </>
  );

  if (providers.isPending)
    return (
      <>
        {header}
        <AiSkeleton rows={3} />
      </>
    );
  if (providers.isError)
    return (
      <>
        {header}
        <ReadError
          message={t("admin.ai.providers.loadError")}
          onRetry={() => void providers.refetch()}
        />
      </>
    );

  const byId = new Map(providers.data.map((p) => [p.id, p]));
  const list = order
    ? order.map((id) => byId.get(id)).filter((p): p is ProviderView => !!p)
    : providers.data;
  const total = list.length;
  const subscriptionOn = list.some((p) => p.kind === "subscription" && p.enabled);
  const subscriptions = list.filter((p) => p.kind === "subscription").length;

  async function moveTo(p: ProviderView, to: number) {
    const from = list.indexOf(p);
    if (to < 0 || to >= total || to === from) return;
    const next = list.map((x) => x.id);
    next.splice(from, 1);
    next.splice(to, 0, p.id);
    setOrder(next);
    setMoveError(null);
    setAnnouncement(t("admin.ai.providers.moved", { name: p.name, position: to + 1, total }));
    const result = await move.mutateAsync([p.id, to]).catch(() => null);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal) {
      setOrder(null);
      setMoveError(refusalWords(refusal.error));
    }
  }

  const at = (id: unknown) => list.findIndex((p) => p.id === id);
  const nameAt = (id: unknown) => list[at(id)]?.name ?? "";
  const announcements: Announcements = {
    onDragStart: ({ active }) => nameAt(active.id),
    onDragOver: ({ active, over }) =>
      over
        ? t("admin.ai.providers.moved", {
            name: nameAt(active.id),
            position: at(over.id) + 1,
            total,
          })
        : undefined,
    onDragEnd: ({ active, over }) =>
      t("admin.ai.providers.moved", {
        name: nameAt(active.id),
        position: (over ? at(over.id) : at(active.id)) + 1,
        total,
      }),
    onDragCancel: ({ active }) =>
      t("admin.ai.providers.moved", {
        name: nameAt(active.id),
        position: at(active.id) + 1,
        total,
      }),
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const p = list[at(active.id)];
    if (p) void moveTo(p, at(over.id));
  };

  return (
    <>
      {header}
      <p id={instructionsId} className="sr-only">
        {t("admin.ai.providers.instructions")}
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {list.length === 0 ? (
        <div className="mt-4 border-t border-rule pt-5">
          <p className="text-md text-ink">{t("admin.ai.providers.empty")}</p>
          {!canWrite && (
            <p className="mt-1 text-sm text-ink-muted">
              {t("admin.ai.providers.emptyReadOnly")} <AiWhoCan scope="providers" />
            </p>
          )}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
          accessibility={{ announcements }}
        >
          <SortableContext items={list.map((p) => p.id)} strategy={verticalListSortingStrategy}>
            <ol
              aria-label={t("admin.ai.providers.list")}
              className="@container mt-4 border-t border-rule"
            >
              {list.map((p, index) => (
                <ProviderRow
                  key={p.id}
                  provider={p}
                  position={index + 1}
                  first={index === 0}
                  last={index === total - 1}
                  canWrite={canWrite}
                  justAdded={added === p.id}
                  subscriptionOn={subscriptionOn}
                  describedBy={instructionsId}
                  onMove={(to) => void moveTo(p, to)}
                  index={index}
                  onReplace={() => setReplacing(p)}
                  onDelete={() => setDeleting(p)}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
      {moveError && (
        <div className="mt-2">
          <ErrorLine>{moveError}</ErrorLine>
        </div>
      )}
      <div className="mt-4 flex flex-col gap-1.5">
        <QuietNote>
          {t("admin.ai.providers.background", { pct: BACKGROUND_WEEKLY_THRESHOLD })}
        </QuietNote>
        {subscriptions >= 2 && <QuietNote>{t("admin.ai.providers.terms")}</QuietNote>}
      </div>
      {canWrite && list.length > 0 && <NextTestBox providers={list} />}
      {adding && (
        <AddProviderDialog
          count={total}
          onClose={() => setAdding(false)}
          onAdded={(id) => setAdded(id)}
        />
      )}
      {replacing && <ReplaceDialog provider={replacing} onClose={() => setReplacing(null)} />}
      {deleting && <DeleteDialog provider={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}

/**
 * Un account (64 px, due righe). Prima: maniglia · posizione · nome · tipo,
 * a destra quota con la sua banda in parole e interruttore. Seconda: la coda
 * della chiave, l'ultima prova (o il ruolo della chiave API), la lettura
 * della quota; a destra Test e «⋯».
 */
function ProviderRow({
  provider: p,
  position,
  index,
  first,
  last,
  canWrite,
  justAdded,
  subscriptionOn,
  describedBy,
  onMove,
  onReplace,
  onDelete,
}: {
  provider: ProviderView;
  position: number;
  index: number;
  first: boolean;
  last: boolean;
  canWrite: boolean;
  justAdded: boolean;
  subscriptionOn: boolean;
  describedBy: string;
  onMove: (to: number) => void;
  onReplace: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const setEnabled = useSetProviderEnabled();
  const test = useTestProvider();
  const refusalWords = useAiRefusalWords();
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const noteId = useId();
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: p.id,
    disabled: !canWrite,
    transition: { duration: 200, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  });

  async function toggle(next: boolean) {
    setError(null);
    const result = await setEnabled.mutateAsync([p.id, next]).catch(() => null);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal)
      return setError(
        refusal.reason === "last_enabled_provider"
          ? t("admin.ai.providers.lastEnabled")
          : refusalWords(refusal.error),
      );
    if (!next) toast.show(t("admin.ai.providers.turnedOff", { name: p.name }));
  }

  async function runTest() {
    setError(null);
    setTesting(true);
    const [result] = await Promise.all([test.mutateAsync(p.id).catch(() => null), wait(TEST_MS)]);
    setTesting(false);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal) return setError(refusalWords(refusal.error));
    const outcome = (result as { outcome: TestOutcome }).outcome;
    if (outcome !== "ok")
      toast.error(t(`admin.ai.providers.testFailed.${outcome}`, { name: p.name }));
  }

  function onHandleKey(e: KeyboardEvent) {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    onMove(index + (e.key === "ArrowUp" ? -1 : 1));
  }

  const muted = !p.enabled;
  // «read 3h ago»: lo stesso formattatore corto del resto dell'app (Impeccable
  // 6), con «Yesterday»/«Just now» in minuscolo dentro la frase.
  const readWords = (iso: string) => {
    const words = ago(iso, t, i18n.language);
    const lower = [t("notifications.time.now"), t("notifications.time.yesterday")].includes(words);
    return lower ? words.toLocaleLowerCase(i18n.language) : words;
  };
  const quota = p.quota;
  const testWords = testing ? (
    <span>{t("admin.ai.providers.testing")}</span>
  ) : p.lastTest === null ? (
    <span>{t("admin.ai.providers.notTested")}</span>
  ) : p.lastTest.outcome === "ok" ? (
    <span>
      {t("admin.ai.providers.tested", { date: formatDate(p.lastTest.at, i18n.language) })}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-critical">
      <CrossGlyph />
      <span>{t(`admin.ai.providers.outcome.${p.lastTest.outcome}`)}</span>
    </span>
  );

  return (
    <li
      ref={setNodeRef}
      data-provider-row={p.id}
      aria-labelledby={nameId}
      style={{
        transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
        transition,
      }}
      className={`relative border-b border-rule transition-colors duration-[var(--duration-base)] ease-out ${
        isDragging
          ? "z-10 rounded-md border border-rule-strong bg-surface"
          : justAdded
            ? "bg-ink/6"
            : ""
      }`}
    >
      <div className="flex min-h-16 flex-col justify-center gap-1 py-2 pr-1">
        {/*
          Due righe su una griglia: maniglia · posizione · nome · quota ·
          interruttore, poi coda della chiave e prova · Test e «⋯». Stretta
          (1024, shape §6) la quota scende sulla seconda riga, l'interruttore
          resta sulla prima.
        */}
        <div
          className={`grid min-w-0 items-center gap-x-3 gap-y-1 ${
            canWrite
              ? "grid-cols-[28px_20px_minmax(0,1fr)_auto_auto]"
              : "grid-cols-[4px_20px_minmax(0,1fr)_auto_auto]"
          }`}
        >
          {canWrite ? (
            <button
              type="button"
              aria-label={t("admin.ai.providers.handle", { name: p.name })}
              aria-describedby={describedBy}
              onKeyDown={onHandleKey}
              {...listeners}
              className="col-start-1 row-start-1 grid size-7 shrink-0 cursor-grab touch-none place-items-center rounded-md text-ink-faint transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink active:cursor-grabbing"
            >
              <GripIcon />
            </button>
          ) : (
            <span className="col-start-1 row-start-1" />
          )}
          <span
            className={`num col-start-2 row-start-1 text-right text-lg font-semibold ${muted ? "text-ink-faint" : "text-ink"}`}
            title={
              p.enabled
                ? t("admin.ai.providers.position", { position })
                : t("admin.ai.providers.disabledPosition")
            }
          >
            {p.enabled ? position : "–"}
          </span>
          <span className="col-start-3 col-end-4 row-start-1 flex min-w-0 items-baseline gap-2 @max-[719px]:col-end-5">
            <span
              id={nameId}
              className={`min-w-0 truncate text-md font-semibold ${muted ? "text-ink-muted" : "text-ink"}`}
            >
              {p.name}
            </span>
            <span className="shrink-0 text-sm text-ink-muted">
              {t(`admin.ai.providers.kind.${p.kind}`)}
            </span>
          </span>
          {quota && (
            <span className="col-start-4 row-start-1 flex justify-end @max-[719px]:row-start-2">
              <QuotaWords quota={quota} />
            </span>
          )}
          <span className="col-start-5 row-start-1 flex shrink-0 items-center justify-end gap-2">
            <span className="w-12 text-right text-xs text-ink-muted" aria-hidden="true">
              {p.enabled ? t("admin.ai.providers.on") : t("admin.ai.providers.off")}
            </span>
            <Switch
              checked={p.enabled}
              label={t("admin.ai.providers.use", { name: p.name })}
              describedBy={p.lastEnabled && canWrite ? noteId : undefined}
              disabledReason={
                !canWrite
                  ? t("admin.ai.readOnly.providers")
                  : p.lastEnabled
                    ? t("admin.ai.providers.lastEnabled")
                    : undefined
              }
              onChange={(next) => void toggle(next)}
            />
          </span>
          <MetaLine
            className="col-start-3 col-end-5 row-start-2 @max-[719px]:col-end-4"
            parts={[
              <span className="num font-mono">{maskedSecret(p.last4)}</span>,
              p.kind === "api_key" &&
                (subscriptionOn
                  ? t("admin.ai.providers.apiKeyStandby")
                  : t("admin.ai.providers.apiKeyInUse")),
              testWords,
              p.kind === "subscription" &&
                (quota
                  ? t("admin.ai.providers.readAgo", { ago: readWords(quota.readAt) })
                  : t("admin.ai.providers.noReading")),
            ]}
          />
          <span className="col-start-5 row-start-2 flex shrink-0 items-center justify-end gap-2">
            {/* Spento per permesso: la frase e «Who?» accanto (GC del maintainer). */}
            {!canWrite && <AiWhoCan scope="providers" />}
            <button
              type="button"
              disabled={!canWrite || testing}
              title={canWrite ? undefined : t("admin.ai.readOnly.providers")}
              aria-describedby={nameId}
              onClick={() => void runTest()}
              className={`${secondaryButton} h-7 px-2.5 disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {t("admin.ai.providers.test")}
            </button>
            {canWrite && (
              <RowMenu label={t("admin.ai.providers.menu", { name: p.name })}>
                {(close) => (
                  <>
                    <MenuItem disabled={first} onSelect={() => (close(true), onMove(index - 1))}>
                      {t("admin.ai.providers.moveUp")}
                    </MenuItem>
                    <MenuItem disabled={last} onSelect={() => (close(true), onMove(index + 1))}>
                      {t("admin.ai.providers.moveDown")}
                    </MenuItem>
                    <MenuItem onSelect={() => (close(false), onReplace())}>
                      {p.kind === "subscription"
                        ? t("admin.ai.providers.replaceToken")
                        : t("admin.ai.providers.replaceKey")}
                    </MenuItem>
                    <MenuItem disabled={p.lastEnabled} onSelect={() => (close(false), onDelete())}>
                      {t("admin.ai.providers.delete")}
                    </MenuItem>
                    {p.lastEnabled && <MenuNote>{t("admin.ai.providers.lastEnabled")}</MenuNote>}
                  </>
                )}
              </RowMenu>
            )}
          </span>
        </div>
        {p.lastEnabled && canWrite && (
          <p id={noteId} className="pl-[72px] text-xs text-ink-muted">
            {t("admin.ai.providers.lastEnabled")}
          </p>
        )}
        {error && (
          <div className={canWrite ? "pl-[72px]" : "pl-12"}>
            <ErrorLine>{error}</ErrorLine>
          </div>
        )}
      </div>
    </li>
  );
}

/** «5h 22% · week 41%» e la banda in parole: «near» col triangolo, «limited» col punto pieno. */
function QuotaWords({ quota }: { quota: NonNullable<ProviderView["quota"]> }) {
  const { t, i18n } = useTranslation();
  const numbers = t("admin.ai.providers.quota", { five: quota.fiveHourPct, week: quota.weeklyPct });
  return (
    <span className="flex shrink-0 items-center gap-3 text-sm">
      {quota.band === "near" && (
        <span className="inline-flex items-center gap-1 font-medium text-warning">
          <TriangleGlyph size={12} />
          <span>{t("admin.ai.providers.near")}</span>
        </span>
      )}
      {quota.band === "limited" && quota.limitedUntil && (
        <span className="inline-flex items-center gap-1.5 font-medium text-critical">
          <span aria-hidden="true" className="size-2 rounded-full bg-critical" />
          <span>{limitedWords(t, quota.limitedUntil, i18n.language)}</span>
        </span>
      )}
      <span className="num text-ink-muted">{numbers}</span>
    </span>
  );
}

/** «At the limit until 16:00», o «until Nov 2» oltre il giorno. */
function limitedWords(
  t: ReturnType<typeof useTranslation>["t"],
  until: string,
  language: string,
): string {
  const sameDay = until.slice(0, 10) === now().slice(0, 10);
  return sameDay
    ? t("admin.ai.providers.limitedUntil", {
        when: new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(
          new Date(until),
        ),
      })
    : t("admin.ai.providers.limitedUntilDay", { when: formatDate(until, language) });
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

/**
 * Il riquadro «Prototype only»: gli account veri non si contattano, e chi
 * prova sceglie cosa risponde la prossima prova di un account. Nessuna voce
 * del registro.
 */
function NextTestBox({ providers }: { providers: ProviderView[] }) {
  const { t } = useTranslation();
  const simulate = useSimulateNextTest();
  const selectId = useId();
  const [target, setTarget] = useState(providers[0]!.id);
  const [outcome, setOutcome] = useState<TestOutcome>("ok");
  const current = providers.some((p) => p.id === target) ? target : providers[0]!.id;
  const choose = (id: string, next: TestOutcome) => {
    setTarget(id);
    setOutcome(next);
    simulate.mutate([id, next]);
  };
  return (
    <div className="mt-8">
      <PrototypeBox label={t("admin.ai.prototype.label")}>
        <p className="text-sm text-ink-muted">{t("admin.ai.providers.prototype.intro")}</p>
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor={selectId} className="text-sm text-ink">
            {t("admin.ai.providers.prototype.account")}
          </label>
          <select
            id={selectId}
            value={current}
            onChange={(e) => choose(e.target.value, outcome)}
            className={`${selectClass} w-48`}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Segmented<TestOutcome>
            label={t("admin.ai.providers.prototype.outcome")}
            value={outcome}
            options={(["ok", "invalid_credentials", "unreachable"] as const).map((o) => ({
              value: o,
              label: t(`admin.ai.providers.prototype.${o}`),
            }))}
            onChange={(o) => choose(current, o)}
          />
        </div>
      </PrototypeBox>
    </div>
  );
}

/** Sostituisce la chiave o il token (+R): la riga torna «not tested yet». */
function ReplaceDialog({ provider: p, onClose }: { provider: ProviderView; onClose: () => void }) {
  const { t } = useTranslation();
  const replace = useReplaceProviderCredential();
  const reauth = useReauth();
  const toast = useToast();
  const refusalWords = useAiRefusalWords();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isToken = p.kind === "subscription";
  const which = isToken ? "Token" : "Key";

  async function submit() {
    if (!value.trim())
      return setError(t(`admin.ai.providers.addDialog.errors.${isToken ? "token" : "key"}`));
    setBusy(true);
    const result = await reauth(() => replace.mutateAsync([p.id, value]), {
      action: t(`admin.ai.providers.replaceDialog.action${which}`, { name: p.name }),
    }).catch(() => null);
    setBusy(false);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal) return setError(refusalWords(refusal.error) || null);
    toast.show(t(`admin.ai.providers.replaceDialog.done${which}`, { name: p.name }));
    onClose();
  }

  return (
    <Dialog
      title={t(`admin.ai.providers.replaceDialog.title${which}`, { name: p.name })}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("admin.ai.cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            className={`${primaryButton} disabled:opacity-40`}
            onClick={() => void submit()}
          >
            {t("admin.ai.providers.replaceDialog.submit")}
          </button>
        </>
      }
    >
      <SecretInput
        label={t(`admin.ai.providers.addDialog.${isToken ? "token" : "key"}`)}
        value={value}
        onChange={setValue}
        error={error}
        autoFocus
      />
      <p className="text-sm text-ink-muted">{t("admin.ai.providers.replaceDialog.running")}</p>
    </Dialog>
  );
}

/** Elimina un account (+R). */
function DeleteDialog({ provider: p, onClose }: { provider: ProviderView; onClose: () => void }) {
  const { t } = useTranslation();
  const remove = useDeleteProvider();
  const reauth = useReauth();
  const toast = useToast();
  const refusalWords = useAiRefusalWords();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    const result = await reauth(() => remove.mutateAsync(p.id), {
      action: t("admin.ai.providers.deleteDialog.action", { name: p.name }),
    }).catch(() => null);
    setBusy(false);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal)
      return setError(
        refusal.reason === "last_enabled_provider"
          ? t("admin.ai.providers.lastEnabled")
          : refusalWords(refusal.error) || null,
      );
    toast.show(t("admin.ai.providers.deleteDialog.done", { name: p.name }));
    onClose();
  }

  return (
    <Dialog
      title={t("admin.ai.providers.deleteDialog.title", { name: p.name })}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("admin.ai.cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            className={dangerSolidButton}
            onClick={() => void submit()}
          >
            {t("admin.ai.providers.deleteDialog.submit")}
          </button>
        </>
      }
    >
      <p className="text-md text-pretty text-ink">{t("admin.ai.providers.deleteDialog.body")}</p>
      {error && <ErrorLine>{error}</ErrorLine>}
    </Dialog>
  );
}

function GripIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {[4, 8, 12].flatMap((y) =>
        [6, 10].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r={1.1} />),
      )}
    </svg>
  );
}
