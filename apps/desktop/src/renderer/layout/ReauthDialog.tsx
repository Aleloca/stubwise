import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  useConfirmEnrollment,
  useEnrollDuringReauth,
  useMySecondFactor,
  useReauthenticate,
  type SecondFactorInput,
  type TotpSetup,
} from "../data/queries";
import { PrototypeBox } from "../pages/automations/shared";
import {
  BackupCodeInput,
  BusyLabel,
  ErrorLine,
  LockedBlock,
  OtherMethods,
  TotpInput,
  textButton,
  wrongCodeMessage,
  type SecondFactorMethod,
} from "../pages/entry/parts";
import { primaryButton, quietButton, secondaryButton } from "../pages/tasks/controls";
import { Dialog } from "../tasks-ui/Dialog";
import { copyText, downloadText } from "../tasks-ui/exportFile";
import { useToast } from "../tasks-ui/Toast";
import { settleReauth, useReauthRequest, type ReauthRequest } from "./useReauth";

/**
 * L'host del dialogo «Confirm it's you», montato una volta nell'`AppLayout`:
 * si apre sopra qualunque pagina quando `useReauth()` riceve
 * `reauth_required`.
 */
export function ReauthHost() {
  const request = useReauthRequest();
  if (!request) return null;
  return <ReauthDialog request={request} />;
}

/** Riporta il fuoco al controllo che aveva aperto l'azione, dopo che il dialogo è sparito. */
function refocus(opener: HTMLElement | null) {
  window.setTimeout(() => {
    if (opener?.isConnected) opener.focus();
  }, 0);
}

function ReauthDialog({ request }: { request: ReauthRequest }) {
  const { t } = useTranslation();
  const toast = useToast();
  const methods = useMySecondFactor();

  const finish = (confirmed: boolean, cancelMessage = t("entry.reauth.nothingChanged")) => {
    if (!confirmed) toast.show(cancelMessage);
    settleReauth(confirmed);
    refocus(request.opener);
  };

  if (methods.isPending || methods.isError)
    return (
      <Dialog title={t("entry.reauth.title")} width={440} onClose={() => finish(false)}>
        {methods.isPending ? (
          <p className="text-sm text-ink-muted" aria-busy="true">
            {t("entry.reauth.checking")}
          </p>
        ) : (
          <ErrorLine
            action={
              <button
                type="button"
                className={`${textButton} ml-1`}
                onClick={() => void methods.refetch()}
              >
                {t("taskUi.states.retry")}
              </button>
            }
          >
            {t("entry.reauth.loadFailed")}
          </ErrorLine>
        )}
      </Dialog>
    );

  if (!methods.data.on) return <EnrollDuringReauth onFinish={finish} />;
  return (
    <ConfirmItsYou
      action={request.action}
      available={{
        passkey: methods.data.passkeys > 0,
        backup_code: methods.data.backupCodesLeft > 0,
      }}
      onFinish={finish}
      // La risposta letta all'apertura era vecchia (il secondo fattore è
      // stato azzerato nel frattempo): si rilegge, e il dialogo passa
      // all'iscrizione al volo.
      onNoSecondFactor={() => void methods.refetch()}
    />
  );
}

type Failure =
  | { kind: "wrong"; triesLeft: number }
  | { kind: "passkey" }
  | { kind: "locked"; until: string }
  | { kind: "noSecondFactor" }
  | { kind: "failed" };

/** Il codice (o la passkey, o un codice di backup) di chi ha già il secondo fattore. */
function ConfirmItsYou({
  action,
  available,
  onFinish,
  onNoSecondFactor,
}: {
  action: string | undefined;
  available: { passkey: boolean; backup_code: boolean };
  onFinish: (confirmed: boolean) => void;
  onNoSecondFactor: () => void;
}) {
  const { t } = useTranslation();
  const reauth = useReauthenticate();
  const [method, setMethod] = useState<SecondFactorMethod>("totp");
  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const lastInput = useRef<SecondFactorInput | null>(null);
  const locked = failure?.kind === "locked";
  const formId = "reauth-form";

  function attempt(input: SecondFactorInput) {
    if (reauth.isPending || locked) return;
    lastInput.current = input;
    setFailure(null);
    reauth.mutate(input, {
      onSuccess: (r) => {
        if (r.ok) return onFinish(true);
        setCode("");
        if (r.error === "invalid_code")
          setFailure(
            input.method === "passkey"
              ? { kind: "passkey" }
              : { kind: "wrong", triesLeft: r.triesLeft },
          );
        else if (r.error === "locked") setFailure({ kind: "locked", until: r.lockedUntil });
        else if (r.error === "no_second_factor") {
          setFailure({ kind: "noSecondFactor" });
          onNoSecondFactor();
        }
        field.current?.focus();
      },
      onError: () => setFailure({ kind: "failed" }),
    });
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (method === "passkey") attempt({ method: "passkey" });
    else attempt({ method, code } as SecondFactorInput);
  }

  const lead = action
    ? t(`entry.reauth.lead.${method}`, { action })
    : t(`entry.reauth.generic.${method}`);
  const message =
    failure?.kind === "wrong"
      ? wrongCodeMessage(t, failure.triesLeft)
      : failure?.kind === "passkey"
        ? t("entry.secondFactor.passkeyFailed")
        : null;

  return (
    <Dialog
      title={t("entry.reauth.title")}
      description={lead}
      width={440}
      onClose={() => onFinish(false)}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={() => onFinish(false)}>
            {t("entry.reauth.cancel")}
          </button>
          {!locked && (
            <button
              type="submit"
              form={formId}
              className={primaryButton}
              aria-busy={reauth.isPending}
            >
              <BusyLabel
                busy={reauth.isPending}
                idle={
                  method === "passkey"
                    ? t("entry.secondFactor.usePasskey")
                    : t("entry.reauth.confirm")
                }
                pending={t("entry.reauth.confirming")}
              />
            </button>
          )}
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-3">
        {method === "totp" && (
          <TotpInput
            label={t("entry.secondFactor.code")}
            inputRef={field}
            value={code}
            disabled={locked}
            error={message}
            onChange={(v) => {
              setCode(v);
              if (v.length === 6) attempt({ method: "totp", code: v });
            }}
          />
        )}
        {method === "backup_code" && (
          <BackupCodeInput
            label={t("entry.secondFactor.backupCode")}
            inputRef={field}
            value={code}
            disabled={locked}
            error={message}
            onChange={setCode}
          />
        )}
        {method === "passkey" && message && <ErrorLine>{message}</ErrorLine>}
        {failure?.kind === "failed" && (
          <ErrorLine
            action={
              <button
                type="button"
                className={`${textButton} ml-1`}
                onClick={() => lastInput.current && attempt(lastInput.current)}
              >
                {t("taskUi.states.retry")}
              </button>
            }
          >
            {t("entry.reauth.failed")}
          </ErrorLine>
        )}
        {failure?.kind === "locked" && <LockedBlock until={failure.until} />}
        {failure?.kind === "noSecondFactor" && (
          <p role="status" className="text-sm text-ink">
            {t("entry.reauth.noSecondFactor")}
          </p>
        )}
        <OtherMethods
          method={method}
          available={available}
          disabled={locked}
          onChange={(m) => {
            setMethod(m);
            setCode("");
            setFailure(null);
          }}
        />
        <p className="text-xs text-ink-faint">{t("entry.reauth.grace")}</p>
      </form>
      <PrototypeBox>
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 text-sm">
          <dt className="text-ink-muted">{t("entry.prototype.code")}</dt>
          <dd className="font-code text-ink">123456</dd>
        </dl>
        {method === "passkey" && !locked && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={secondaryButton}
              onClick={() => attempt({ method: "passkey" })}
            >
              {t("entry.prototype.simulatePasskey")}
            </button>
            <button
              type="button"
              className={secondaryButton}
              onClick={() => attempt({ method: "passkey", simulate: "fail" })}
            >
              {t("entry.prototype.simulateFailedPasskey")}
            </button>
          </div>
        )}
      </PrototypeBox>
    </Dialog>
  );
}

const STEPS = ["scan", "confirm", "save"] as const;

/**
 * L'iscrizione al volo (Sara, senza secondo fattore) [IN 5]: la chiave e il
 * QR, il primo codice, i codici di backup (una volta, con «I've saved
 * them»). «Continue» chiude e l'azione riparte; «Cancel» prima del terzo
 * passo non attiva niente.
 */
function EnrollDuringReauth({
  onFinish,
}: {
  onFinish: (confirmed: boolean, cancelMessage?: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const enroll = useEnrollDuringReauth();
  const confirm = useConfirmEnrollment();
  const [step, setStep] = useState<(typeof STEPS)[number]>("scan");
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const started = useRef(false);
  const locked = failure?.kind === "locked";

  // Il segreto si prepara una volta, all'apertura.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    enroll.mutate(undefined, { onSuccess: setSetup });
  }, [enroll]);

  const cancel = () => onFinish(false, t("entry.reauth.enroll.cancelled"));

  function check(value: string) {
    if (confirm.isPending || locked) return;
    setFailure(null);
    confirm.mutate(value, {
      onSuccess: (r) => {
        if (r.ok) {
          setCodes(r.backupCodes ?? []);
          setStep("save");
          return;
        }
        setCode("");
        if (r.error === "invalid_code") setFailure({ kind: "wrong", triesLeft: r.triesLeft });
        else if (r.error === "locked") setFailure({ kind: "locked", until: r.lockedUntil });
        else setFailure({ kind: "failed" });
        field.current?.focus();
      },
      onError: () => setFailure({ kind: "failed" }),
    });
  }

  async function copy(text: string) {
    try {
      await copyText(text);
      toast.show(t("entry.reauth.enroll.copied"));
    } catch {
      toast.error(t("entry.reauth.enroll.copyFailed"));
    }
  }

  const index = STEPS.indexOf(step);
  const footer =
    step === "save" ? (
      <button
        type="button"
        className={`${primaryButton} disabled:opacity-40`}
        disabled={!saved}
        onClick={() => onFinish(true)}
      >
        {t("entry.reauth.enroll.continue")}
      </button>
    ) : (
      <>
        <button type="button" className={secondaryButton} onClick={cancel}>
          {t("entry.reauth.cancel")}
        </button>
        {step === "scan" ? (
          <button
            type="button"
            className={`${primaryButton} disabled:opacity-40`}
            disabled={!setup}
            onClick={() => setStep("confirm")}
          >
            {t("entry.reauth.enroll.next")}
          </button>
        ) : (
          !locked && (
            <button
              type="submit"
              form="reauth-enroll-form"
              className={primaryButton}
              aria-busy={confirm.isPending}
            >
              <BusyLabel
                busy={confirm.isPending}
                idle={t("entry.reauth.confirm")}
                pending={t("entry.reauth.confirming")}
              />
            </button>
          )
        )}
      </>
    );

  return (
    <Dialog
      title={t("entry.reauth.title")}
      width={440}
      // Al terzo passo il secondo fattore è già acceso: si esce solo da «Continue».
      onClose={() => (step === "save" ? undefined : cancel())}
      footer={footer}
    >
      <ol
        aria-label={t("entry.reauth.enroll.stepsLabel")}
        className="flex flex-wrap gap-x-3 text-xs"
      >
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={i === index ? "step" : undefined}
            className={i === index ? "font-semibold text-ink" : "text-ink-muted"}
          >
            <span className="num">{i + 1}</span> {t(`entry.reauth.enroll.steps.${s}`)}
          </li>
        ))}
      </ol>
      {step === "scan" && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink">{t("entry.reauth.enroll.intro")}</p>
          {enroll.isError ? (
            <ErrorLine
              action={
                <button
                  type="button"
                  className={`${textButton} ml-1`}
                  onClick={() => enroll.mutate(undefined, { onSuccess: setSetup })}
                >
                  {t("taskUi.states.retry")}
                </button>
              }
            >
              {t("entry.reauth.enroll.startFailed")}
            </ErrorLine>
          ) : setup ? (
            <>
              <figure className="flex flex-col items-start gap-1.5">
                <div
                  className="size-40 rounded-md border border-rule bg-white p-2 text-black [&>svg]:size-full"
                  role="img"
                  aria-label={t("entry.reauth.enroll.qrLabel")}
                  dangerouslySetInnerHTML={{ __html: setup.qrSvg }}
                />
                <figcaption className="text-xs text-ink-muted">
                  {t("entry.reauth.enroll.qrNote")}
                </figcaption>
              </figure>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm text-ink-muted">{t("entry.reauth.enroll.cantScan")}</span>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 font-code break-all text-ink">
                    {setup.secret}
                  </code>
                  <button type="button" className={quietButton} onClick={() => copy(setup.secret)}>
                    {t("entry.reauth.enroll.copy")}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-ink-muted" aria-busy="true">
              {t("entry.reauth.checking")}
            </p>
          )}
        </div>
      )}
      {step === "confirm" && (
        <form
          id="reauth-enroll-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            check(code);
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-sm text-ink">{t("entry.reauth.enroll.enterFirst")}</p>
          <TotpInput
            label={t("entry.secondFactor.code")}
            inputRef={field}
            value={code}
            disabled={locked}
            error={failure?.kind === "wrong" ? wrongCodeMessage(t, failure.triesLeft) : null}
            onChange={(v) => {
              setCode(v);
              if (v.length === 6) check(v);
            }}
          />
          {failure?.kind === "failed" && <ErrorLine>{t("entry.reauth.failed")}</ErrorLine>}
          {failure?.kind === "locked" && <LockedBlock until={failure.until} />}
          <PrototypeBox>
            <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 text-sm">
              <dt className="text-ink-muted">{t("entry.prototype.code")}</dt>
              <dd className="font-code text-ink">123456</dd>
            </dl>
          </PrototypeBox>
        </form>
      )}
      {step === "save" && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink">{t("entry.reauth.enroll.saveCodes")}</p>
          <ul
            aria-label={t("entry.reauth.enroll.codesLabel")}
            className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-rule px-3 py-2.5"
          >
            {codes.map((c) => (
              <li key={c} className="font-code text-ink">
                {c}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button
              type="button"
              className={secondaryButton}
              onClick={() =>
                downloadText("stubwise-backup-codes.txt", codes.join("\n"), "text/plain")
              }
            >
              {t("entry.reauth.enroll.download")}
            </button>
            <button
              type="button"
              className={secondaryButton}
              onClick={() => copy(codes.join("\n"))}
            >
              {t("entry.reauth.enroll.copy")}
            </button>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
              className="size-3.5"
            />
            {t("entry.reauth.enroll.saved")}
          </label>
        </div>
      )}
    </Dialog>
  );
}
