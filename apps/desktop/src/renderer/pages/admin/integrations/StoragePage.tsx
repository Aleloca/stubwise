import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SecretInput, maskedSecret } from "../../../components/SecretField";
import {
  useSaveStorage,
  useSetAttachments,
  useSimulateNextTest,
  useStorage,
  useTestStorage,
  type StorageStatus,
  type StorageView,
  type TestOutcome,
} from "../../../data/queries";
import { useReauth } from "../../../layout/useReauth";
import { useToast } from "../../../tasks-ui/Toast";
import { PrototypeBox } from "../../automations/shared";
import { Segmented } from "../../automations/builder/controls";
import { ErrorLine } from "../../entry/parts";
import { CheckGlyph, OpenCircleGlyph } from "../../preferences/glyphs";
import { ReadError, refusalOf } from "../../preferences/parts";
import { Switch } from "../../preferences/SubscriptionRow";
import { InlineConfirm } from "../../task/parts";
import { primaryButton, quietButton, secondaryButton } from "../../tasks/controls";
import { AiSkeleton } from "../ai/parts";
import {
  CHECK_MS,
  CheckWords,
  CrossGlyph,
  IntegrationPage,
  TextField,
  useRefusalWords,
  wait,
} from "./parts";

// Storage (shape admin-integrations.md «Storage»): il bucket compatibile S3
// dei file del Drive e degli allegati. La voce c'è solo con
// `settings.manage`. In testa la riga di stato, che dice il livello dati
// (`status`): se si può caricare, e se no perché. Salvare con una chiave
// nuova chiede la riconferma (+R), senza no; la chiave vive solo nello stato
// del modulo mentre si scrive, poi resta «•••• w3m7» (RF 1). Gli allegati si
// spengono con una conferma a due tempi e subito, fuori dal Save. La
// verifica prova la configurazione salvata.

type Field = "endpoint" | "region" | "bucket" | "access_key_id" | "secret_access_key";
type Errors = Partial<Record<Field | "check" | "attachments" | "form", string>>;

const FIELDS: readonly Field[] = ["endpoint", "region", "bucket", "access_key_id", "secret_access_key"];

export function StoragePage() {
  const { t } = useTranslation();
  const storage = useStorage();
  return (
    <IntegrationPage title={t("admin.storage.title")} intro={t("admin.storage.intro")}>
      {storage.isPending ? (
        <div className="mt-6">
          <AiSkeleton rows={4} height={56} />
        </div>
      ) : storage.isError ? (
        <ReadError message={t("admin.storage.loadError")} onRetry={() => void storage.refetch()} />
      ) : (
        <StorageForm storage={storage.data} />
      )}
    </IntegrationPage>
  );
}

/** La riga di stato in testa (14 px col glifo), dal livello dati. */
function StatusLine({ status }: { status: StorageStatus }) {
  const { t } = useTranslation();
  const glyph =
    status === "on" ? (
      <CheckGlyph size={14} />
    ) : status === "check_failed" ? (
      <CrossGlyph size={14} />
    ) : (
      <OpenCircleGlyph size={14} />
    );
  return (
    <div className="mt-6 border-t border-rule pt-5">
      <p
        role="status"
        className={`flex items-center gap-2 text-md font-medium ${status === "check_failed" ? "text-critical" : "text-ink"}`}
      >
        <span className="shrink-0">{glyph}</span>
        <span>{t(`admin.storage.status.${status}`)}</span>
      </p>
      <p className="mt-1 pl-[22px] text-xs text-ink-muted">{t("admin.storage.stays")}</p>
    </div>
  );
}

function StorageForm({ storage: s }: { storage: StorageView }) {
  const { t } = useTranslation();
  const save = useSaveStorage();
  const testStorage = useTestStorage();
  const setAttachments = useSetAttachments();
  const reauth = useReauth();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const [endpoint, setEndpoint] = useState(s.endpoint);
  const [region, setRegion] = useState(s.region);
  const [bucket, setBucket] = useState(s.bucket);
  const [accessKeyId, setAccessKeyId] = useState(s.accessKeyId);
  // La chiave nuova: solo qui, mentre si scrive.
  const [replacing, setReplacing] = useState(s.last4 === null);
  const [secret, setSecret] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const writing = replacing || s.last4 === null;

  async function submit() {
    if (writing && !secret.trim())
      return setErrors({ secret_access_key: t("admin.storage.errors.secret_access_key") });
    setErrors({});
    setBusy(true);
    const input = {
      endpoint,
      region,
      bucket,
      accessKeyId,
      ...(writing ? { secretAccessKey: secret } : {}),
    };
    const result = await (writing
      ? reauth(() => save.mutateAsync(input), { action: t("admin.storage.saveAction") })
      : save.mutateAsync(input)
    ).catch(() => null);
    setBusy(false);
    if (result === null) return setErrors({ form: t("admin.integrations.saveFailed") });
    const refusal = refusalOf(result);
    if (refusal) {
      if (refusal.error === "invalid" && FIELDS.includes(refusal.reason as Field))
        return setErrors({ [refusal.reason!]: t(`admin.storage.errors.${refusal.reason}`) });
      const form = refusalWords(refusal.error);
      return setErrors(form ? { form } : {});
    }
    setSecret("");
    setReplacing(false);
    toast.show(t("admin.integrations.saved"));
  }

  async function check() {
    setErrors((e) => ({ ...e, check: undefined }));
    setChecking(true);
    const [result] = await Promise.all([
      testStorage.mutateAsync(undefined).catch(() => null),
      wait(CHECK_MS),
    ]);
    setChecking(false);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (!refusal) return;
    const words =
      refusal.error === "invalid" && refusal.reason === "not_set_up"
        ? t("admin.storage.errors.not_set_up")
        : refusalWords(refusal.error);
    if (words) setErrors((e) => ({ ...e, check: words }));
  }

  async function turn(on: boolean) {
    setConfirmOff(false);
    setErrors((e) => ({ ...e, attachments: undefined }));
    const result = await setAttachments.mutateAsync(on).catch(() => null);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (!refusal) return;
    const words =
      refusal.error === "invalid" && refusal.reason === "not_set_up"
        ? t("admin.storage.errors.not_set_up")
        : refusalWords(refusal.error);
    if (words) setErrors((e) => ({ ...e, attachments: words }));
  }

  return (
    <>
      <StatusLine status={s.status} />
      <div className="mt-6 flex max-w-[560px] flex-col gap-4">
        <TextField
          label={t("admin.storage.endpoint")}
          value={endpoint}
          onChange={setEndpoint}
          placeholder="https://s3.eu-south-1.amazonaws.com"
          error={errors.endpoint}
        />
        <div className="grid grid-cols-2 gap-4">
          <TextField
            label={t("admin.storage.region")}
            value={region}
            onChange={setRegion}
            placeholder="eu-south-1"
            error={errors.region}
          />
          <TextField
            label={t("admin.storage.bucket")}
            value={bucket}
            onChange={setBucket}
            error={errors.bucket}
          />
        </div>
        <TextField
          label={t("admin.storage.accessKeyId")}
          value={accessKeyId}
          onChange={setAccessKeyId}
          error={errors.access_key_id}
        />
        {writing ? (
          <div className="flex flex-col gap-1.5">
            <SecretInput
              label={t("admin.storage.secretKey")}
              value={secret}
              onChange={setSecret}
              error={errors.secret_access_key}
              autoFocus={replacing && s.last4 !== null}
            />
            {s.last4 !== null && (
              <button
                type="button"
                onClick={() => {
                  setSecret("");
                  setReplacing(false);
                  setErrors((e) => ({ ...e, secret_access_key: undefined }));
                }}
                className={`${quietButton} h-7 self-start`}
              >
                {t("admin.storage.cancelReplace")}
              </button>
            )}
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">{t("admin.storage.secretKey")}</span>
            <span className="flex min-h-8 items-center gap-3">
              <span className="num text-md text-ink">{maskedSecret(s.last4!)}</span>
              <button
                type="button"
                onClick={() => setReplacing(true)}
                className={`${secondaryButton} h-7 px-2.5`}
              >
                {t("admin.storage.replace")}
              </button>
            </span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className={`${primaryButton} disabled:opacity-40`}
          >
            {t("admin.storage.save")}
          </button>
          {errors.form && <ErrorLine>{errors.form}</ErrorLine>}
        </div>
      </div>

      <div className="mt-8 flex max-w-[560px] flex-col gap-5 border-t border-rule pt-5">
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-3">
            <span className="flex h-6 items-center">
              <Switch
                checked={s.attachmentsEnabled}
                label={t("admin.storage.attachments")}
                onChange={(on) => (on ? void turn(true) : setConfirmOff(true))}
              />
            </span>
            <span className="min-w-0">
              <span aria-hidden="true" className="block text-md font-medium text-ink">
                {t("admin.storage.attachments")}
              </span>
              <span className="block text-sm text-pretty text-ink-muted">
                {t("admin.storage.attachmentsBody")}
              </span>
            </span>
          </div>
          {confirmOff && (
            <InlineConfirm
              message={t("admin.storage.turnOff")}
              confirm={t("admin.storage.turnOffConfirm")}
              cancelLabel={t("admin.storage.keepOn")}
              onConfirm={() => void turn(false)}
              onCancel={() => setConfirmOff(false)}
            />
          )}
          {errors.attachments && <ErrorLine>{errors.attachments}</ErrorLine>}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button
              type="button"
              disabled={checking}
              onClick={() => void check()}
              className={`${secondaryButton} disabled:opacity-40`}
            >
              {t("admin.storage.check")}
            </button>
            <span className="text-sm text-ink-muted">
              <CheckWords checking={checking} last={s.lastTest} />
            </span>
          </div>
          {errors.check && <ErrorLine>{errors.check}</ErrorLine>}
        </div>
      </div>

      <NextCheckBox />
    </>
  );
}

/** Il riquadro «Prototype only»: cosa risponde la prossima verifica dell'archiviazione. */
function NextCheckBox() {
  const { t } = useTranslation();
  const simulate = useSimulateNextTest();
  const [outcome, setOutcome] = useState<TestOutcome>("ok");
  return (
    <div className="mt-8 max-w-[560px]">
      <PrototypeBox label={t("admin.integrations.prototype.label")}>
        <p className="text-sm text-ink-muted">{t("admin.integrations.prototype.checkIntro")}</p>
        <Segmented<TestOutcome>
          label={t("admin.integrations.prototype.outcome")}
          value={outcome}
          options={(["ok", "invalid_credentials", "unreachable"] as const).map((o) => ({
            value: o,
            label: t(`admin.integrations.prototype.${o}`),
          }))}
          onChange={(o) => {
            setOutcome(o);
            simulate.mutate(["storage", o]);
          }}
        />
      </PrototypeBox>
    </div>
  );
}
