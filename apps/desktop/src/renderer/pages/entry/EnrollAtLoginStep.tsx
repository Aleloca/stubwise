import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SECOND_FACTOR_MAX_FAILURES,
  useConfirmLoginEnrollment,
  useStartLoginEnrollment,
} from "../../data/queries";
import { copyText, downloadText } from "../../tasks-ui/exportFile";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import { BusyLabel, EntryHeading, ErrorLine, TotpInput, textButton, wrongCodeMessage } from "./parts";

const STEPS = ["scan", "confirm", "save"] as const;

/**
 * La configurazione obbligatoria del secondo fattore al login (build app,
 * integrazione area 2, fetta 1; decisione del maintainer del 9 nov 2026):
 * chi non ha l'app di autenticazione la configura prima di entrare, come
 * chiede il server (`stage: "enrollment"`). Il prototipo non ha questa
 * pagina: è costruita coi pezzi dell'ingresso e coi tre passi della
 * configurazione dentro la riconferma (QR e chiave, primo codice, codici di
 * riserva una volta, con «I've saved them»). Annotata in
 * `apps/desktop/docs/integration-slice1.md`.
 */
export function EnrollAtLoginStep({
  onBack,
  onFinishing,
  onDone,
}: {
  onBack: () => void;
  onFinishing: (finishing: boolean) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const start = useStartLoginEnrollment();
  const { confirm, enter } = useConfirmLoginEnrollment();
  const [step, setStep] = useState<(typeof STEPS)[number]>("scan");
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<"wrong" | "expired" | "failed" | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [personId, setPersonId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const started = useRef(false);

  function begin() {
    start.mutate(undefined, {
      onSuccess: async (r) => {
        const qrSvg = await QRCode.toString(r.otpauthUrl, { type: "svg", margin: 0 });
        setSetup({ secret: r.secret, qrSvg });
      },
    });
  }

  // Il segreto si prepara una volta, all'apertura.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    begin();
  });

  function check(value: string) {
    if (confirm.isPending) return;
    setFailure(null);
    // Dentro, ma con un passo da mostrare: la pagina non se ne va da sola.
    onFinishing(true);
    confirm.mutate(value, {
      onSuccess: (r) => {
        if (r.ok) {
          setCodes(r.backupCodes);
          setPersonId(r.personId);
          setStep("save");
          return;
        }
        onFinishing(false);
        setCode("");
        setFailure(r.error === "invalid_code" ? "wrong" : "expired");
        field.current?.focus();
      },
      onError: () => {
        onFinishing(false);
        setFailure("failed");
      },
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

  if (failure === "expired")
    return (
      <>
        <EntryHeading title={t("entry.enrollAtLogin.title")} />
        <ErrorLine>{t("entry.secondFactor.expired")}</ErrorLine>
        <button type="button" className={`${textButton} mt-4 self-start text-sm`} onClick={onBack}>
          {t("entry.secondFactor.backToSignIn")}
        </button>
      </>
    );

  const index = STEPS.indexOf(step);
  return (
    <>
      <EntryHeading title={t("entry.enrollAtLogin.title")} lead={t("entry.enrollAtLogin.lead")} />
      <ol aria-label={t("entry.reauth.enroll.stepsLabel")} className="mb-5 flex flex-wrap gap-x-3 text-xs">
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
        <div className="flex flex-col gap-4">
          {start.isError ? (
            <ErrorLine
              action={
                <button type="button" className={`${textButton} ml-1`} onClick={begin}>
                  {t("taskUi.states.retry")}
                </button>
              }
            >
              {t("entry.reauth.enroll.startFailed")}
            </ErrorLine>
          ) : setup ? (
            <>
              <div
                className="size-40 rounded-md border border-rule bg-white p-2 text-black [&>svg]:size-full"
                role="img"
                aria-label={t("entry.reauth.enroll.qrLabel")}
                dangerouslySetInnerHTML={{ __html: setup.qrSvg }}
              />
              <div className="flex flex-col gap-1.5">
                <span className="text-sm text-ink-muted">{t("entry.reauth.enroll.cantScan")}</span>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 font-code break-all text-ink">{setup.secret}</code>
                  <button type="button" className={quietButton} onClick={() => void copy(setup.secret)}>
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
          <div className="flex justify-end">
            <button
              type="button"
              className={`${primaryButton} disabled:opacity-40`}
              disabled={!setup}
              onClick={() => setStep("confirm")}
            >
              {t("entry.reauth.enroll.next")}
            </button>
          </div>
        </div>
      )}

      {step === "confirm" && (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            check(code);
          }}
          className="flex flex-col gap-4"
        >
          <p className="text-sm text-ink">{t("entry.reauth.enroll.enterFirst")}</p>
          <TotpInput
            label={t("entry.secondFactor.code")}
            inputRef={field}
            value={code}
            autoFocus
            error={failure === "wrong" ? wrongCodeMessage(t, SECOND_FACTOR_MAX_FAILURES - 1) : null}
            onChange={(v) => {
              setCode(v);
              if (v.length === 6) check(v);
            }}
          />
          {failure === "failed" && <ErrorLine>{t("entry.secondFactor.failed")}</ErrorLine>}
          <div className="flex justify-end">
            <button type="submit" className={primaryButton} aria-busy={confirm.isPending}>
              <BusyLabel
                busy={confirm.isPending}
                idle={t("entry.secondFactor.verify")}
                pending={t("entry.secondFactor.verifying")}
              />
            </button>
          </div>
        </form>
      )}

      {step === "save" && (
        <div className="flex flex-col gap-4">
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
              onClick={() => downloadText("stubwise-backup-codes.txt", codes.join("\n"), "text/plain")}
            >
              {t("entry.reauth.enroll.download")}
            </button>
            <button type="button" className={secondaryButton} onClick={() => void copy(codes.join("\n"))}>
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
          <div className="flex justify-end">
            <button
              type="button"
              className={`${primaryButton} disabled:opacity-40`}
              disabled={!saved}
              onClick={() => {
                if (personId) enter(personId);
                onDone();
              }}
            >
              {t("entry.reauth.enroll.continue")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
