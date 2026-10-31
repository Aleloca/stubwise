import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useImportEnvFile } from "../../../data/queries";
import { useReauth } from "../../../layout/useReauth";
import { Dialog, inputClass } from "../../../tasks-ui/Dialog";
import { ErrorLine } from "../../entry/parts";
import { CheckGlyph } from "../../preferences/glyphs";
import { smallSecondary } from "../../task/parts";
import { primaryButton, secondaryButton } from "../../tasks/controls";
import { useSettingsWrite } from "../SettingsFrame";
import type { FileTarget } from "./EnvFiles";

// «Import…» di un file d'ambiente (shape project-repositories.md [RE 5]):
// testo incollato o un `.env` scelto dal computer, letto nel campo e da
// nessun'altra parte. All'invio l'area si svuota SUBITO, prima della
// riconferma: il testo non resta nel dialogo, nemmeno se la riconferma si
// annulla [RE 8] (si reincolla). L'esito dice i numeri e le righe saltate
// col loro numero e il perché, mai il contenuto. «Niente da importare» lo
// dice il livello dati senza chiedere la riconferma: lì il testo torna
// nell'area, perché lo si possa correggere.

type Outcome = {
  imported: string[];
  replaced: string[];
  skipped: { line: number; reason: "syntax" | "key" }[];
};

export function ImportEnvDialog({
  code,
  target,
  onReload,
  onClose,
}: {
  code: string;
  target: FileTarget;
  onReload: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const reauth = useReauth();
  const importFile = useImportEnvFile();
  const write = useSettingsWrite(code, onReload);
  const [content, setContent] = useState("");
  const [nothing, setNothing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  // Con l'esito il fuoco va a «Done»: l'esito si legge (role status) e si chiude.
  useEffect(() => {
    if (outcome) doneRef.current?.focus();
  }, [outcome]);
  const id = useId();
  const words = { path: target.file.path, env: target.environment.name };

  async function submit() {
    if (busy) return;
    const sent = content;
    setContent("");
    setNothing(false);
    setBusy(true);
    let result: Outcome | null = null;
    const ok = await write.run(
      async () => {
        const r = await reauth(
          () => importFile.mutateAsync({ fileId: target.file.id, content: sent }),
          {
            action: t("settings.envFiles.importDialog.reauthAction", words),
          },
        );
        if (r.ok) result = { imported: r.imported, replaced: r.replaced, skipped: r.skipped };
        return r;
      },
      (reason) => {
        if (reason === "nothing_to_import") {
          setNothing(true);
          setContent(sent);
        }
      },
    );
    setBusy(false);
    if (ok) setOutcome(result);
  }

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    setContent(await file.text());
    setNothing(false);
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <Dialog
      title={t("settings.envFiles.importDialog.title", words)}
      onClose={onClose}
      width={560}
      confirmDiscard={
        !outcome && content.trim() !== ""
          ? {
              message: t("settings.envFiles.importDialog.discard"),
              keep: t("settings.envFiles.importDialog.keep"),
              discard: t("settings.envFiles.importDialog.discardButton"),
            }
          : undefined
      }
      footer={(dismiss) =>
        outcome ? (
          <button ref={doneRef} type="button" className={primaryButton} onClick={onClose}>
            {t("settings.envFiles.importDialog.done")}
          </button>
        ) : (
          <>
            <button type="button" className={secondaryButton} onClick={dismiss}>
              {t("settings.envFiles.cancel")}
            </button>
            <button
              type="button"
              aria-disabled={busy || undefined}
              className={`${primaryButton} aria-disabled:opacity-40`}
              onClick={() => void submit()}
            >
              {busy
                ? t("settings.envFiles.importDialog.importing")
                : t("settings.envFiles.importDialog.import")}
            </button>
          </>
        )
      }
    >
      {outcome ? (
        <OutcomeWords outcome={outcome} />
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-end justify-between gap-3">
              <label htmlFor={`${id}-content`} className="text-sm font-medium text-ink">
                {t("settings.envFiles.importDialog.label")}
              </label>
              <button
                type="button"
                className={smallSecondary}
                onClick={() => fileInput.current?.click()}
              >
                {t("settings.envFiles.importDialog.choose")}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".env,text/plain"
                hidden
                tabIndex={-1}
                onChange={(e) => void chooseFile(e.target.files?.[0])}
              />
            </div>
            <textarea
              id={`${id}-content`}
              data-autofocus
              rows={8}
              value={content}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              placeholder="KEY=value"
              aria-invalid={nothing || undefined}
              aria-describedby={nothing ? `${id}-nothing ${id}-hint` : `${id}-hint`}
              onChange={(e) => {
                setContent(e.target.value);
                setNothing(false);
              }}
              className={`${inputClass} min-h-[168px] resize-y font-code leading-5 [font-size:13px]`}
            />
            <p id={`${id}-hint`} className="text-xs text-pretty text-ink-muted">
              {t("settings.envFiles.importDialog.hint")}
            </p>
          </div>
          {nothing && (
            <ErrorLine id={`${id}-nothing`}>
              {t("settings.envFiles.importDialog.nothing")}
            </ErrorLine>
          )}
        </>
      )}
      {write.message}
    </Dialog>
  );
}

/** «2 imported, 1 replaced, line 3 skipped.» e, per ogni riga saltata, il perché (mai il contenuto). */
function OutcomeWords({ outcome }: { outcome: Outcome }) {
  const { t, i18n } = useTranslation();
  const lines = new Intl.ListFormat(i18n.language, { style: "short", type: "conjunction" }).format(
    outcome.skipped.map((s) => String(s.line)),
  );
  const parts = [
    t("settings.envFiles.importDialog.imported", { count: outcome.imported.length }),
    outcome.replaced.length > 0 &&
      t("settings.envFiles.importDialog.replaced", { count: outcome.replaced.length }),
    outcome.skipped.length > 0 &&
      t("settings.envFiles.importDialog.skipped", { count: outcome.skipped.length, lines }),
  ].filter(Boolean);
  return (
    <div role="status" className="flex flex-col gap-2">
      <p className="flex items-start gap-1.5 text-md text-ink">
        <span className="mt-[3px] shrink-0 text-positive">
          <CheckGlyph size={14} />
        </span>
        <span className="num">{`${parts.join(", ")}.`}</span>
      </p>
      {outcome.skipped.length > 0 && (
        <ul className="flex flex-col gap-1 pl-5 text-sm text-ink-muted">
          {outcome.skipped.map((s) => (
            <li key={s.line} className="num">
              {t(`settings.envFiles.importDialog.${s.reason}`, { line: s.line })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
