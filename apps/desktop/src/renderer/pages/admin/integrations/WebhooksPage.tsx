import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  WEBHOOK_EVENTS,
  useSaveWebhook,
  useSimulateNextTest,
  useTestWebhook,
  useWebhook,
  useWebhookPreview,
  type TestOutcome,
  type WebhookEventId,
  type WebhookFormat,
  type WebhookGroup,
  type WebhookView,
} from "../../../data/queries";
import { formatDate } from "../../../notifications/time";
import { useToast } from "../../../tasks-ui/Toast";
import { PrototypeBox } from "../../automations/shared";
import { Segmented } from "../../automations/builder/controls";
import { ErrorLine } from "../../entry/parts";
import { ReadError, refusalOf } from "../../preferences/parts";
import { Switch } from "../../preferences/SubscriptionRow";
import { primaryButton, quietButton, secondaryButton } from "../../tasks/controls";
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

// Outgoing webhooks (shape admin-integrations.md «Outgoing webhooks»): un
// messaggio a un canale di chat o a un endpoint quando succede qualcosa in
// un progetto. La voce c'è solo con `settings.manage`. L'indirizzo NON è un
// segreto (maintainer, 30 ott 2026): campo di testo normale, sempre riletto
// col valore salvato, e salvarlo non chiede la riconferma. Gli eventi sono i
// 21 di `WEBHOOK_EVENTS`, nei sei gruppi dello shape, un interruttore
// ciascuno; le risposte dei clienti non ci sono mai (maintainer). A 1440 il
// modulo sta a sinistra e l'anteprima a destra; a 1024 l'anteprima scende
// sotto gli eventi, chiusa dietro «Show preview». La prova va all'indirizzo
// salvato.

const FORMATS: readonly WebhookFormat[] = ["slack", "discord", "generic"];
const GROUPS: readonly WebhookGroup[] = ["tasks", "work", "prs", "docs", "servers", "project"];
/** Quanti passi ha «How to get the address» per formato (chiavi `s1…sN`). */
const STEPS: Record<WebhookFormat, number> = { slack: 5, discord: 5, generic: 3 };
/** L'evento d'esempio di partenza: «New task in ACQ». */
const FIRST_EVENT: WebhookEventId = "ticket.created";

export function WebhooksPage() {
  const { t } = useTranslation();
  const webhook = useWebhook();
  return (
    <IntegrationPage title={t("admin.webhooks.title")} intro={t("admin.webhooks.intro")} wide>
      {webhook.isPending ? (
        <div className="@container">
          <div className="mt-6 grid gap-10 @min-[960px]:grid-cols-[560px_minmax(0,1fr)]">
            <AiSkeleton rows={6} height={44} />
            <AiSkeleton rows={1} height={160} />
          </div>
        </div>
      ) : webhook.isError ? (
        <ReadError message={t("admin.webhooks.loadError")} onRetry={() => void webhook.refetch()} />
      ) : (
        <div className="@container">
          <WebhookForm webhook={webhook.data} />
        </div>
      )}
    </IntegrationPage>
  );
}

function WebhookForm({ webhook: w }: { webhook: WebhookView }) {
  const { t } = useTranslation();
  const save = useSaveWebhook();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const [enabled, setEnabled] = useState(w.enabled);
  const [format, setFormat] = useState<WebhookFormat>(w.format);
  const [url, setUrl] = useState(w.url ?? "");
  const [events, setEvents] = useState<Record<WebhookEventId, boolean>>(w.events);
  const [previewEvent, setPreviewEvent] = useState<WebhookEventId>(FIRST_EVENT);
  const [showPreview, setShowPreview] = useState(false);
  const [errors, setErrors] = useState<{ url?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const previewId = useId();
  const onCount = WEBHOOK_EVENTS.filter((e) => events[e.id]).length;
  // La prova va all'indirizzo salvato: lo si dice se quello scritto è un altro.
  const unsavedTarget = url.trim() !== (w.url ?? "") || format !== w.format;

  async function submit() {
    setErrors({});
    setBusy(true);
    const result = await save
      .mutateAsync({ enabled, format, url: url.trim() || null, events })
      .catch(() => null);
    setBusy(false);
    if (result === null) return setErrors({ form: t("admin.integrations.saveFailed") });
    const refusal = refusalOf(result);
    if (refusal) {
      if (refusal.error === "invalid" && refusal.reason === "url")
        return setErrors({
          url: url.trim() ? t("admin.webhooks.errors.https") : t("admin.webhooks.errors.missing"),
        });
      const form = refusalWords(refusal.error);
      return setErrors(form ? { form } : {});
    }
    toast.show(t("admin.integrations.saved"));
  }

  return (
    <div className="mt-6 grid gap-x-10 gap-y-8 border-t border-rule pt-6 @min-[960px]:grid-cols-[560px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-6">
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
          mono
        />

        <Disclosure title={t("admin.webhooks.howTo")}>
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-pretty text-ink marker:text-ink-muted">
            {Array.from({ length: STEPS[format] }, (_, i) => (
              <li key={i}>{t(`admin.webhooks.steps.${format}.s${i + 1}`)}</li>
            ))}
          </ol>
        </Disclosure>

        <EventsSection
          events={events}
          onCount={onCount}
          onToggle={(id, on) => setEvents((e) => ({ ...e, [id]: on }))}
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
              {t("admin.webhooks.save")}
            </button>
            <TestButton webhook={w} unsavedTarget={unsavedTarget} />
          </div>
          {errors.form && <ErrorLine>{errors.form}</ErrorLine>}
        </div>

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

      <div className="max-w-[560px] @min-[960px]:col-span-2">
        <NextTestBox />
      </div>
    </div>
  );
}

/**
 * Gli eventi, nei sei gruppi: un interruttore per evento, «12 of 21 on» in
 * testa. Il fuoco o il passaggio su una riga ne fa l'evento dell'anteprima.
 */
function EventsSection({
  events,
  onCount,
  onToggle,
  onPoint,
}: {
  events: Record<WebhookEventId, boolean>;
  onCount: number;
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
          {t("admin.webhooks.onCount", { on: onCount, total: WEBHOOK_EVENTS.length })}
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
                    checked={events[e.id]}
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

/** «Send a test» e il suo esito: la prova va all'indirizzo salvato. */
function TestButton({ webhook: w, unsavedTarget }: { webhook: WebhookView; unsavedTarget: boolean }) {
  const { t } = useTranslation();
  const test = useTestWebhook();
  const refusalWords = useRefusalWords();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setError(null);
    setSending(true);
    const [result] = await Promise.all([
      test.mutateAsync(undefined).catch(() => null),
      wait(CHECK_MS),
    ]);
    setSending(false);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (!refusal) return;
    setError(
      refusal.error === "invalid" && refusal.reason === "url"
        ? t("admin.webhooks.errors.testNeedsAddress")
        : refusalWords(refusal.error) || null,
    );
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
