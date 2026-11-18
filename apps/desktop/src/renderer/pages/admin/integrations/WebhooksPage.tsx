import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  WEBHOOK_EVENTS,
  WEBHOOK_LIMIT,
  useCreateWebhook,
  useDeleteWebhook,
  useRegenerateOutgoingWebhookSecret,
  useSimulateNextTest,
  useTestWebhook,
  useUpdateWebhook,
  useWebhook,
  useWebhookPreview,
  useWebhooks,
  type TestOutcome,
  type WebhookEventId,
  type WebhookFormat,
  type WebhookGroup,
  type WebhookView,
} from "../../../data/queries";
import { isAppBuild } from "../../../data/build";
import { useReauth } from "../../../layout/useReauth";
import { formatDate } from "../../../notifications/time";
import { Dialog } from "../../../tasks-ui/Dialog";
import { useToast } from "../../../tasks-ui/Toast";
import { PrototypeBox } from "../../automations/shared";
import { Segmented } from "../../automations/builder/controls";
import { ErrorLine } from "../../entry/parts";
import { ReadError, refusalOf } from "../../preferences/parts";
import { SecretOnce } from "../../preferences/SecretOnce";
import { Switch } from "../../preferences/SubscriptionRow";
import { dangerSolidButton, primaryButton, quietButton, secondaryButton } from "../../tasks/controls";
import { AiSkeleton } from "../ai/parts";
import {
  CHECK_MS,
  CrossGlyph,
  Disclosure,
  Dot,
  IntegrationPage,
  QuietNote,
  TextField,
  useRefusalWords,
  wait,
} from "./parts";

// Outgoing webhooks (shape admin-integrations.md «Outgoing webhooks»;
// integrazione area 9, F3, D-10 = b): un ELENCO di webhook, ognuno col suo
// nome, indirizzo, formato, eventi e segreto di firma. La voce c'è con
// `integrations.manage` (H-1). L'indirizzo NON è un segreto (maintainer, 30
// ott 2026): campo di testo normale, riletto col valore salvato, e cambiarlo
// non chiede la riconferma. Il segreto di firma lo genera Stubwise: si vede
// UNA volta, alla creazione e alla rigenerazione (con la riconferma), in un
// `SecretOnce` che vive solo nello stato del componente; eliminare chiede la
// riconferma. Gli eventi sono i 21 di `WEBHOOK_EVENTS`, nei sei gruppi dello
// shape; le risposte dei clienti non ci sono mai (maintainer). A 1440 il
// modulo sta a sinistra e l'anteprima a destra; a 1024 l'anteprima scende
// sotto gli eventi, chiusa dietro «Show preview». La prova va all'indirizzo
// salvato, anche con i messaggi spenti.

const FORMATS: readonly WebhookFormat[] = ["slack", "discord", "generic"];
const GROUPS: readonly WebhookGroup[] = ["tasks", "work", "prs", "docs", "servers", "project"];
/** Quanti passi ha «How to get the address» per formato (chiavi `s1…sN`). */
const STEPS: Record<WebhookFormat, number> = { slack: 5, discord: 5, generic: 3 };
/** L'evento d'esempio di partenza: «New task in ACQ». */
const FIRST_EVENT: WebhookEventId = "ticket.created";

/** `/admin/webhooks`: l'elenco e «New webhook». */
export function WebhooksPage() {
  const { t } = useTranslation();
  const webhooks = useWebhooks();
  const full = (webhooks.data?.length ?? 0) >= WEBHOOK_LIMIT;
  return (
    <IntegrationPage
      title={t("admin.webhooks.title")}
      intro={t("admin.webhooks.intro")}
      action={
        webhooks.data && (
          <Link
            to="/admin/webhooks/$webhookId"
            params={{ webhookId: "new" }}
            aria-disabled={full || undefined}
            title={full ? t("admin.webhooks.limit", { count: WEBHOOK_LIMIT }) : undefined}
            onClick={(e) => full && e.preventDefault()}
            className={`${primaryButton} ${full ? "opacity-40" : ""}`}
          >
            {t("admin.webhooks.new")}
          </Link>
        )
      }
    >
      {webhooks.isPending ? (
        <div className="mt-6">
          <AiSkeleton rows={3} height={52} />
        </div>
      ) : webhooks.isError ? (
        <ReadError message={t("admin.webhooks.loadError")} onRetry={() => void webhooks.refetch()} />
      ) : webhooks.data.length === 0 ? (
        <p className="mt-6 border-t border-rule pt-6 text-md text-ink">{t("admin.webhooks.empty")}</p>
      ) : (
        <>
          <ul className="mt-6 border-t border-rule">
            {webhooks.data.map((w) => (
              <WebhookRow key={w.id} webhook={w} />
            ))}
          </ul>
          {full && (
            <div className="mt-3">
              <QuietNote>{t("admin.webhooks.limit", { count: WEBHOOK_LIMIT })}</QuietNote>
            </div>
          )}
        </>
      )}
    </IntegrationPage>
  );
}

function WebhookRow({ webhook: w }: { webhook: WebhookView }) {
  const { t } = useTranslation();
  return (
    <li data-webhook-row className="border-b border-rule py-3">
      <div className="flex items-baseline gap-3">
        <Link
          to="/admin/webhooks/$webhookId"
          params={{ webhookId: w.id }}
          className="min-w-0 truncate text-md font-medium text-ink underline-offset-4 hover:underline"
        >
          {w.name}
        </Link>
        <span className="text-sm text-ink-muted">{t(`admin.webhooks.formats.${w.format}`)}</span>
        {!w.enabled && (
          <span className="rounded-sm bg-ink/6 px-1.5 text-xs text-ink-muted">
            {t("admin.webhooks.offBadge")}
          </span>
        )}
        <span className="num ml-auto shrink-0 text-sm text-ink-muted">
          {t("admin.webhooks.eventCount", { count: w.events.length, total: WEBHOOK_EVENTS.length })}
        </span>
      </div>
      <p className="mt-0.5 truncate text-sm text-ink-muted">{w.url}</p>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-sm text-ink-muted">
        <TestWords sending={false} last={w.lastTest} />
      </p>
    </li>
  );
}

/** `/admin/webhooks/$webhookId` (e `new`): il modulo, il segreto, l'eliminazione, l'anteprima. */
export function WebhookPage({ webhookId }: { webhookId: string }) {
  const { t } = useTranslation();
  const isNew = webhookId === "new";
  const webhook = useWebhook(isNew ? undefined : webhookId);
  return (
    <section className="page-header pb-16 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <div className="max-w-[1040px]">
        <Link
          to="/admin/$section"
          params={{ section: "webhooks" }}
          data-back-link
          className="inline-flex items-center gap-1 rounded-sm text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:text-ink"
        >
          <span aria-hidden="true">←</span>
          <span>{t("admin.webhooks.back")}</span>
        </Link>
        {isNew ? (
          <NewWebhook />
        ) : webhook.isPending ? (
          <div className="mt-6 grid gap-10">
            <AiSkeleton rows={6} height={44} />
          </div>
        ) : webhook.isError ? (
          (webhook.error as Error).message === "not_found" ? (
            <p className="mt-4 text-md text-ink">{t("admin.webhooks.notFound")}</p>
          ) : (
            <ReadError
              message={t("admin.webhooks.loadOneError")}
              onRetry={() => void webhook.refetch()}
            />
          )
        ) : (
          <WebhookForm key={webhook.data.id} webhook={webhook.data} />
        )}
      </div>
    </section>
  );
}

const BLANK: WebhookView = {
  id: "",
  name: "",
  url: "",
  format: "slack",
  enabled: true,
  events: [],
  secretSet: false,
  secretRotatedAt: null,
  createdAt: "",
  lastTest: null,
};

/** Un webhook nuovo: creato (con la riconferma), il segreto si vede qui, una volta. */
function NewWebhook() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [created, setCreated] = useState<{ id: string; secret: string } | null>(null);
  if (created)
    return (
      <div className="mt-6 max-w-[560px]">
        <SecretOnce
          title={t("admin.webhooks.createdTitle")}
          value={created.secret}
          onDone={() =>
            void navigate({ to: "/admin/webhooks/$webhookId", params: { webhookId: created.id } })
          }
        >
          <p className="text-sm text-ink-muted">{t("admin.webhooks.secret.note")}</p>
        </SecretOnce>
      </div>
    );
  return <WebhookForm webhook={BLANK} onCreated={setCreated} />;
}

function WebhookForm({
  webhook: w,
  onCreated,
}: {
  webhook: WebhookView;
  /** Solo per un webhook nuovo: il segreto appena nato. */
  onCreated?: (r: { id: string; secret: string }) => void;
}) {
  const { t } = useTranslation();
  const isNew = onCreated !== undefined;
  const create = useCreateWebhook();
  const update = useUpdateWebhook();
  const reauth = useReauth();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const [name, setName] = useState(w.name);
  const [enabled, setEnabled] = useState(w.enabled);
  const [format, setFormat] = useState<WebhookFormat>(w.format);
  const [url, setUrl] = useState(w.url);
  const [events, setEvents] = useState<WebhookEventId[]>(w.events);
  const [previewEvent, setPreviewEvent] = useState<WebhookEventId>(FIRST_EVENT);
  const [showPreview, setShowPreview] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; url?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const previewId = useId();
  const on = new Set(events);
  // La prova va all'indirizzo salvato: lo si dice se quello scritto è un altro.
  const unsavedTarget = url.trim() !== w.url || format !== w.format;

  async function submit() {
    setErrors({});
    if (!name.trim()) return setErrors({ name: t("admin.webhooks.errors.name") });
    if (!url.trim()) return setErrors({ url: t("admin.webhooks.errors.missing") });
    setBusy(true);
    const input = { name: name.trim(), url: url.trim(), format, enabled, events };
    const result = await (
      isNew
        ? reauth(() => create.mutateAsync(input), {
            action: t("admin.webhooks.createAction", { name: input.name }),
          })
        : input.url !== w.url
          ? // Un indirizzo nuovo chiede la riconferma (maintainer, 18 nov 2026).
            reauth(() => update.mutateAsync([w.id, input]), {
              action: t("admin.webhooks.urlAction", { name: w.name }),
            })
          : update.mutateAsync([w.id, input])
    ).catch(() => null);
    setBusy(false);
    if (result === null) return setErrors({ form: t("admin.integrations.saveFailed") });
    const refusal = refusalOf(result);
    if (refusal) {
      if (refusal.error === "invalid" && refusal.reason === "url")
        return setErrors({ url: t("admin.webhooks.errors.https") });
      if (refusal.error === "invalid" && refusal.reason === "name")
        return setErrors({ name: t("admin.webhooks.errors.name") });
      if (
        refusal.error === "invalid" &&
        (refusal.reason === "webhook_limit" || refusal.reason === "events")
      )
        return setErrors({ form: t(`admin.webhooks.errors.${refusal.reason}`) });
      const form = refusalWords(refusal.error);
      return setErrors(form ? { form } : {});
    }
    if (isNew && "webhook" in result) {
      const created = result as unknown as { webhook: WebhookView; secret: string };
      onCreated({ id: created.webhook.id, secret: created.secret });
      return;
    }
    toast.show(t("admin.integrations.saved"));
  }

  return (
    <div className="@container">
      <h1 tabIndex={-1} className="mt-4 text-2xl font-semibold tracking-[-0.01em] text-ink outline-none">
        {isNew ? t("admin.webhooks.newTitle") : w.name}
      </h1>
      <div className="mt-6 grid gap-x-10 gap-y-8 border-t border-rule pt-6 @min-[960px]:grid-cols-[560px_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <TextField
            label={t("admin.webhooks.name")}
            value={name}
            onChange={setName}
            error={errors.name}
          />

          <div className="flex flex-col gap-1.5">
            <span className="flex items-center gap-2.5 text-md font-medium text-ink">
              <Switch checked={enabled} label={t("admin.webhooks.send")} onChange={setEnabled} />
              <span aria-hidden="true">{t("admin.webhooks.send")}</span>
            </span>
            {!enabled && (
              <div className="pl-[42px]">
                <QuietNote>{t("admin.webhooks.off")}</QuietNote>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <span aria-hidden="true" className="text-sm font-medium text-ink">
              {t("admin.webhooks.format")}
            </span>
            <Segmented<WebhookFormat>
              label={t("admin.webhooks.format")}
              value={format}
              options={FORMATS.map((f) => ({ value: f, label: t(`admin.webhooks.formats.${f}`) }))}
              onChange={setFormat}
            />
          </div>

          <TextField
            label={t("admin.webhooks.address")}
            value={url}
            onChange={setUrl}
            placeholder={format === "slack" ? "https://hooks.slack.com/services/…" : "https://…"}
            hint={t("admin.webhooks.addressNote")}
            error={errors.url}
          />

          <Disclosure title={t("admin.webhooks.howTo")}>
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-pretty text-ink marker:text-ink-muted">
              {Array.from({ length: STEPS[format] }, (_, i) => (
                <li key={i}>{t(`admin.webhooks.steps.${format}.s${i + 1}`)}</li>
              ))}
            </ol>
          </Disclosure>

          <EventsSection
            events={on}
            onToggle={(id, value) =>
              setEvents((list) =>
                value ? [...list.filter((e) => e !== id), id] : list.filter((e) => e !== id),
              )
            }
            onPoint={setPreviewEvent}
          />

          <div className="flex flex-col gap-2 border-t border-rule pt-5">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => void submit()}
                className={`${primaryButton} disabled:opacity-40`}
              >
                {isNew
                  ? busy
                    ? t("admin.webhooks.creating")
                    : t("admin.webhooks.create")
                  : t("admin.webhooks.save")}
              </button>
              {!isNew && <TestButton webhook={w} unsavedTarget={unsavedTarget} />}
            </div>
            {errors.form && <ErrorLine>{errors.form}</ErrorLine>}
          </div>

          {!isNew && <SecretSection webhook={w} />}
          {!isNew && <DeleteSection webhook={w} />}

          {/* A 1024: l'anteprima scende qui, chiusa di default. */}
          <button
            type="button"
            aria-expanded={showPreview}
            aria-controls={previewId}
            onClick={() => setShowPreview((s) => !s)}
            className={`${quietButton} self-start @min-[960px]:hidden`}
          >
            {showPreview ? t("admin.webhooks.hidePreview") : t("admin.webhooks.showPreview")}
          </button>
        </div>

        <div
          id={previewId}
          className={`${showPreview ? "" : "hidden"} min-w-0 @min-[960px]:sticky @min-[960px]:top-8 @min-[960px]:block @min-[960px]:self-start @min-[960px]:border-l @min-[960px]:border-rule @min-[960px]:pl-10`}
        >
          <Preview eventId={previewEvent} format={format} />
        </div>

        {/* L'esito della prossima prova si sceglie solo nel prototipo. */}
        {!isNew && !isAppBuild() && (
          <div className="max-w-[560px] @min-[960px]:col-span-2">
            <NextTestBox />
          </div>
        )}
      </div>
    </div>
  );
}

/** Il segreto di firma: impostato e quando; «Regenerate secret» con la riconferma, il nuovo una volta. */
function SecretSection({ webhook: w }: { webhook: WebhookView }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2 border-t border-rule pt-5">
      <h2 id={titleId} className="text-xl font-semibold text-ink">
        {t("admin.webhooks.secret.title")}
      </h2>
      <p className="text-md text-ink">
        {w.secretSet && w.secretRotatedAt ? (
          <span className="num">
            {t("admin.webhooks.secret.set", { date: formatDate(w.secretRotatedAt, i18n.language) })}
          </span>
        ) : (
          t("admin.webhooks.secret.none")
        )}
      </p>
      <p className="text-sm text-pretty text-ink-muted">{t("admin.webhooks.secret.note")}</p>
      <div>
        <button type="button" className={secondaryButton} onClick={() => setOpen(true)}>
          {t("admin.webhooks.secret.regenerate")}
        </button>
      </div>
      {open && <RegenerateDialog webhook={w} onClose={() => setOpen(false)} />}
    </section>
  );
}

function RegenerateDialog({ webhook: w, onClose }: { webhook: WebhookView; onClose: () => void }) {
  const { t } = useTranslation();
  const regenerate = useRegenerateOutgoingWebhookSecret();
  const reauth = useReauth();
  const refusalWords = useRefusalWords();
  // Il valore vive solo qui: «Done» chiude il dialogo e lo butta.
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    setBusy(true);
    const result = await reauth(() => regenerate.mutateAsync(w.id), {
      action: t("admin.webhooks.secret.action", { name: w.name }),
    }).catch(() => null);
    setBusy(false);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal) return setError(refusalWords(refusal.error) || null);
    if (result && result.ok) setSecret(result.secret);
  }

  return (
    <Dialog
      title={t("admin.webhooks.secret.dialogTitle", { name: w.name })}
      onClose={onClose}
      width={480}
      footer={
        secret ? undefined : (
          <>
            <button type="button" className={secondaryButton} onClick={onClose}>
              {t("admin.integrations.cancel")}
            </button>
            <button
              type="button"
              aria-disabled={busy || undefined}
              className={dangerSolidButton}
              onClick={() => void submit()}
            >
              {t("admin.webhooks.secret.submit")}
            </button>
          </>
        )
      }
    >
      {secret ? (
        <SecretOnce title={t("admin.webhooks.secret.shownTitle")} value={secret} onDone={onClose} />
      ) : (
        <>
          <p className="text-md text-pretty text-ink">{t("admin.webhooks.secret.dialogBody")}</p>
          {error && <ErrorLine>{error}</ErrorLine>}
        </>
      )}
    </Dialog>
  );
}

/** «Delete webhook», con la riconferma; poi si torna all'elenco. */
function DeleteSection({ webhook: w }: { webhook: WebhookView }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-rule pt-5">
      <button type="button" className={secondaryButton} onClick={() => setOpen(true)}>
        {t("admin.webhooks.delete.button")}
      </button>
      {open && <DeleteDialog webhook={w} onClose={() => setOpen(false)} />}
    </div>
  );
}

function DeleteDialog({ webhook: w, onClose }: { webhook: WebhookView; onClose: () => void }) {
  const { t } = useTranslation();
  const remove = useDeleteWebhook();
  const reauth = useReauth();
  const toast = useToast();
  const navigate = useNavigate();
  const refusalWords = useRefusalWords();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    const result = await reauth(() => remove.mutateAsync(w.id), {
      action: t("admin.webhooks.delete.action", { name: w.name }),
    }).catch(() => null);
    setBusy(false);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal) return setError(refusalWords(refusal.error) || null);
    toast.show(t("admin.webhooks.delete.done", { name: w.name }));
    onClose();
    void navigate({ to: "/admin/$section", params: { section: "webhooks" } });
  }

  return (
    <Dialog
      title={t("admin.webhooks.delete.title", { name: w.name })}
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
            {t("admin.webhooks.delete.submit")}
          </button>
        </>
      }
    >
      <p className="text-md text-pretty text-ink">{t("admin.webhooks.delete.body")}</p>
      {error && <ErrorLine>{error}</ErrorLine>}
    </Dialog>
  );
}

/**
 * Gli eventi, nei sei gruppi: un interruttore per evento, «12 of 21 on» in
 * testa. Il fuoco o il passaggio su una riga ne fa l'evento dell'anteprima.
 */
function EventsSection({
  events,
  onToggle,
  onPoint,
}: {
  events: ReadonlySet<WebhookEventId>;
  onToggle: (id: WebhookEventId, on: boolean) => void;
  onPoint: (id: WebhookEventId) => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-4 border-t border-rule pt-5">
      <div className="flex items-baseline gap-3">
        <h2 id={titleId} className="text-xl font-semibold text-ink">
          {t("admin.webhooks.events")}
        </h2>
        <span className="num text-sm text-ink-muted">
          {t("admin.webhooks.onCount", { on: events.size, total: WEBHOOK_EVENTS.length })}
        </span>
      </div>
      {GROUPS.map((group) => (
        <div
          key={group}
          role="group"
          aria-label={t(`admin.webhooks.groups.${group}`)}
          className="flex flex-col"
        >
          <p aria-hidden="true" className="heading-group pb-1">
            {t(`admin.webhooks.groups.${group}`)}
          </p>
          <ul className="flex flex-col">
            {WEBHOOK_EVENTS.filter((e) => e.group === group).map((e) => {
              const label = t(`admin.webhooks.event.${e.id}`);
              return (
                <li
                  key={e.id}
                  onMouseEnter={() => onPoint(e.id)}
                  onFocus={() => onPoint(e.id)}
                  className="flex min-h-9 items-center gap-2.5 border-b border-rule py-1.5 last:border-b-0"
                >
                  <Switch
                    checked={events.has(e.id)}
                    label={label}
                    onChange={(on) => onToggle(e.id, on)}
                  />
                  <span aria-hidden="true" className="min-w-0 text-md text-pretty text-ink">
                    {label}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** «Send a test» e il suo esito: la prova va all'indirizzo salvato, anche con i messaggi spenti. */
function TestButton({ webhook: w, unsavedTarget }: { webhook: WebhookView; unsavedTarget: boolean }) {
  const { t } = useTranslation();
  const test = useTestWebhook();
  const refusalWords = useRefusalWords();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setError(null);
    setSending(true);
    const [result] = await Promise.all([test.mutateAsync(w.id).catch(() => null), wait(CHECK_MS)]);
    setSending(false);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (!refusal) return;
    setError(refusalWords(refusal.error) || null);
  }

  return (
    <>
      <button
        type="button"
        disabled={sending}
        onClick={() => void send()}
        className={`${secondaryButton} disabled:opacity-40`}
      >
        {t("admin.webhooks.test")}
      </button>
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm text-ink-muted">
        <TestWords sending={sending} last={w.lastTest} />
      </span>
      {(error || unsavedTarget) && (
        <span className="basis-full">
          {error ? (
            <ErrorLine>{error}</ErrorLine>
          ) : (
            <span className="text-xs text-ink-muted">{t("admin.webhooks.testsSaved")}</span>
          )}
        </span>
      )}
    </>
  );
}

/** L'esito dell'ultima prova, in parole: «Sent · delivered · Oct 28» o l'errore (`critical`). */
function TestWords({
  sending,
  last,
}: {
  sending: boolean;
  last: WebhookView["lastTest"];
}) {
  const { t, i18n } = useTranslation();
  if (sending) return <span>{t("admin.webhooks.sending")}</span>;
  if (!last) return <span>{t("admin.webhooks.result.never")}</span>;
  const date = <span className="num">{formatDate(last.at, i18n.language)}</span>;
  if (last.outcome === "ok")
    return (
      <>
        <span>{t("admin.webhooks.result.ok")}</span>
        <Dot />
        {date}
      </>
    );
  return (
    <>
      <span className="inline-flex items-center gap-1 text-critical">
        <CrossGlyph />
        <span>{t(`admin.webhooks.result.${last.outcome}`)}</span>
      </span>
      <Dot />
      {date}
    </>
  );
}

/**
 * L'anteprima del messaggio dell'evento scelto nel formato scelto: Slack e
 * Discord resi come messaggio (grassetto, link), il JSON in un blocco di
 * codice. Dati d'esempio, dichiarati.
 */
function Preview({ eventId, format }: { eventId: WebhookEventId; format: WebhookFormat }) {
  const { t } = useTranslation();
  const preview = useWebhookPreview(eventId, format);
  return (
    <section aria-label={t("admin.webhooks.preview")} className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <p aria-hidden="true" className="heading-group">
          {t("admin.webhooks.preview")}
        </p>
        <span className="text-xs text-ink-muted">{t("admin.webhooks.example")}</span>
      </div>
      <p className="text-sm text-ink-muted">{t(`admin.webhooks.event.${eventId}`)}</p>
      {preview.data === undefined ? (
        <div aria-busy="true" className="skeleton-breathe h-20 rounded-md bg-ink/4" />
      ) : format === "generic" ? (
        <pre className="overflow-x-auto rounded-md border border-rule bg-ink/4 px-3 py-2.5 text-xs leading-5 text-ink">
          <code className="num">{preview.data}</code>
        </pre>
      ) : (
        <div className="rounded-md border border-rule px-3 py-3">
          <p className="text-sm font-semibold text-ink">Stubwise</p>
          <p className="mt-0.5 text-md text-pretty break-words text-ink">
            {renderMessage(preview.data, format)}
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * Il testo di Slack (`*grassetto*`, `<url|etichetta>`) o Discord
 * (`**grassetto**`, `[etichetta](url)`) reso come lo mostrerebbe la chat:
 * il link è sottolineato e porta l'indirizzo nel `title`, ma non si apre
 * (dati d'esempio).
 */
function renderMessage(text: string, format: "slack" | "discord"): ReactNode[] {
  const pattern =
    format === "slack" ? /\*([^*]+)\*|<([^|>]+)\|([^>]+)>/g : /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    if (m[1] !== undefined) out.push(<strong key={m.index}>{m[1]}</strong>);
    else {
      const [label, url] = format === "slack" ? [m[3]!, m[2]!] : [m[2]!, m[3]!];
      out.push(
        <span key={m.index} title={url} className="text-ink underline underline-offset-4">
          {label}
        </span>,
      );
    }
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Il riquadro «Prototype only»: cosa risponde la prossima prova del webhook. */
function NextTestBox() {
  const { t } = useTranslation();
  const simulate = useSimulateNextTest();
  const [outcome, setOutcome] = useState<TestOutcome>("ok");
  return (
    <PrototypeBox label={t("admin.integrations.prototype.label")}>
      <p className="text-sm text-ink-muted">{t("admin.webhooks.prototype.intro")}</p>
      <Segmented<TestOutcome>
        label={t("admin.webhooks.prototype.outcome")}
        value={outcome}
        options={(["ok", "invalid_credentials", "unreachable"] as const).map((o) => ({
          value: o,
          label: t(`admin.webhooks.prototype.${o}`),
        }))}
        onChange={(o) => {
          setOutcome(o);
          simulate.mutate(["webhook", o]);
        }}
      />
    </PrototypeBox>
  );
}
