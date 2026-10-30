import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  useLoginSecondFactor,
  useMySecondFactor,
  usePassMinutes,
  type SecondFactorInput,
} from "../../data/queries";
import { PrototypeBox } from "../automations/shared";
import { primaryButton, secondaryButton } from "../tasks/controls";
import {
  BackupCodeInput,
  BusyLabel,
  EntryHeading,
  ErrorLine,
  LockedBlock,
  OtherMethods,
  TotpInput,
  textButton,
  wrongCodeMessage,
  type SecondFactorMethod,
} from "./parts";

/** Oltre questi codici di backup rimasti, dopo l'ingresso con uno di loro si va dritti alla Home. */
const LOW_BACKUP_CODES = 3;

type Failure =
  | { kind: "wrong"; triesLeft: number }
  | { kind: "passkey" }
  | { kind: "locked"; until: string }
  | { kind: "expired" }
  | { kind: "failed" };

/**
 * Il secondo passo del login: il codice dell'app (alla sesta cifra parte da
 * solo), la passkey o un codice di backup. Il blocco spegne tutto e dice fino
 * a quando; la passkey e i codici di backup passano dallo stesso contatore.
 */
export function SecondFactorStep({
  email,
  onBack,
  onFinishing,
  onDone,
}: {
  email: string;
  onBack: () => void;
  onFinishing: (finishing: boolean) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const verify = useLoginSecondFactor();
  const pass = usePassMinutes();
  const [method, setMethod] = useState<SecondFactorMethod>("totp");
  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [usedBackup, setUsedBackup] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const locked = failure?.kind === "locked";
  const lastInput = useRef<SecondFactorInput | null>(null);

  // Dopo l'ingresso con un codice di backup: quanti ne restano (la persona è già quella nuova).
  const left = useMySecondFactor(usedBackup).data?.backupCodesLeft;
  useEffect(() => {
    if (!usedBackup || left === undefined) return;
    if (left > LOW_BACKUP_CODES) onDone();
  }, [usedBackup, left, onDone]);

  function attempt(input: SecondFactorInput) {
    if (verify.isPending || locked) return;
    lastInput.current = input;
    setFailure(null);
    // Un codice di backup può aver lasciato pochi codici: c'è un passo in più
    // da mostrare prima della Home, quindi la pagina non deve andarsene da sola.
    onFinishing(input.method === "backup_code");
    verify.mutate(input, {
      onSuccess: (r) => {
        if (r.ok) {
          if (input.method === "backup_code") setUsedBackup(true);
          else onDone();
          return;
        }
        onFinishing(false);
        setCode("");
        if (r.error === "invalid_code")
          setFailure(
            input.method === "passkey"
              ? { kind: "passkey" }
              : { kind: "wrong", triesLeft: r.triesLeft },
          );
        else if (r.error === "locked") setFailure({ kind: "locked", until: r.lockedUntil });
        else setFailure({ kind: "expired" });
        field.current?.focus();
      },
      onError: () => {
        onFinishing(false);
        setFailure({ kind: "failed" });
      },
    });
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (method === "totp") attempt({ method: "totp", code });
    else if (method === "backup_code") attempt({ method: "backup_code", code });
    else attempt({ method: "passkey" });
  }

  if (usedBackup && left !== undefined && left <= LOW_BACKUP_CODES)
    return (
      <>
        <EntryHeading title={t("entry.secondFactor.lowBackupTitle")} />
        <p className="mb-6 text-md text-ink">
          {t("entry.secondFactor.lowBackup", { count: left })}
        </p>
        <div className="flex justify-end">
          <button type="button" className={primaryButton} onClick={onDone} autoFocus>
            {t("entry.secondFactor.continue")}
          </button>
        </div>
      </>
    );

  if (failure?.kind === "expired")
    return (
      <>
        <EntryHeading title={t("entry.secondFactor.title")} />
        <ErrorLine>{t("entry.secondFactor.expired")}</ErrorLine>
        <button type="button" className={`${textButton} mt-4 self-start text-sm`} onClick={onBack}>
          {t("entry.secondFactor.backToSignIn")}
        </button>
      </>
    );

  const message =
    failure?.kind === "wrong"
      ? wrongCodeMessage(t, failure.triesLeft)
      : failure?.kind === "passkey"
        ? t("entry.secondFactor.passkeyFailed")
        : null;

  return (
    <>
      <EntryHeading
        title={t("entry.secondFactor.title")}
        lead={t(`entry.secondFactor.lead.${method}`)}
      />
      {email && (
        <p className="-mt-3 mb-6 text-xs text-ink-muted">
          {t("entry.secondFactor.signingInAs", { email })} <span aria-hidden="true">·</span>{" "}
          <button type="button" className={textButton} onClick={onBack}>
            {t("entry.secondFactor.notYou")}
          </button>
        </p>
      )}
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {method === "totp" && (
          <TotpInput
            label={t("entry.secondFactor.code")}
            inputRef={field}
            value={code}
            disabled={locked}
            autoFocus
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
            {t("entry.secondFactor.failed")}
          </ErrorLine>
        )}
        {failure?.kind === "locked" ? (
          <LockedBlock until={failure.until}>
            <button type="button" className={`${textButton} self-start text-sm`} onClick={onBack}>
              {t("entry.secondFactor.backToSignIn")}
            </button>
          </LockedBlock>
        ) : (
          <div className="flex justify-end">
            <button type="submit" className={primaryButton} aria-busy={verify.isPending}>
              <BusyLabel
                busy={verify.isPending}
                idle={
                  method === "passkey"
                    ? t("entry.secondFactor.usePasskey")
                    : t("entry.secondFactor.verify")
                }
                pending={t("entry.secondFactor.verifying")}
              />
            </button>
          </div>
        )}
        <OtherMethods
          method={method}
          disabled={locked}
          onChange={(m) => {
            setMethod(m);
            setCode("");
            setFailure(null);
          }}
        />
      </form>
      <div className="mt-10">
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
          {locked && (
            <div>
              <button
                type="button"
                className={secondaryButton}
                disabled={pass.isPending}
                onClick={() =>
                  pass.mutate(15, {
                    onSuccess: () => {
                      setFailure(null);
                      // Il login a metà dura 10 minuti: dopo 15 si ridà la password.
                      onBack();
                    },
                  })
                }
              >
                {t("entry.prototype.passMinutes")}
              </button>
            </div>
          )}
        </PrototypeBox>
      </div>
    </>
  );
}
