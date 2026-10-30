import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  useAddPasskey,
  useConfirmTotp,
  useEndSession,
  useMySecurity,
  useRegenerateBackupCodes,
  useRemovePasskey,
  useRenamePasskey,
  useStartFirstTotpSetup,
  useStartTotpSetup,
  type MySecurity,
  type TotpSetup,
} from "../../data/queries";
import { useReauth } from "../../layout/useReauth";
import { inputClass } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { PrototypeBox } from "../automations/shared";
import { BusyLabel, EntryField, LockedBlock, TotpInput, wrongCodeMessage } from "../entry/parts";
import { formatDateTime } from "../../notifications/time";
import { whenWithTime } from "../mail/format";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { CheckGlyph, OpenCircleGlyph, TriangleGlyph } from "./glyphs";
import {
  ArmedButton,
  Part,
  PrefsPage,
  ReadError,
  Reveal,
  RowMenu,
  RowMenuItem,
  RowsSkeleton,
  WriteError,
  refusalOf,
  rowButton,
  rowClass,
  useDateLabel,
  useDayWord,
} from "./parts";
import { SecretOnce } from "./SecretOnce";

// Preferenze → Security (shape preferences-account.md): la riga di stato in
// testa, l'app di autenticazione (configurazione in posto [PR 5]), le
// passkey, i codici di backup, le sessioni aperte e il registro. Il secondo
// fattore non si spegne: si sostituisce un metodo. Chiave TOTP e codici di
// backup si vedono una volta (`SecretOnce`), solo nello stato di questa
// sezione: lasciata la pagina non tornano.

type Passkey = MySecurity["passkeys"][number];
type Session = MySecurity["sessions"][number];

/** Le righe del registro mostrate prima di «Show all». */
const LOG_FIRST = 10;

export function SecuritySection() {
  const { t } = useTranslation();
  const security = useMySecurity();
  const appPart = useRef<HTMLElement>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  // I codici di backup della prima attivazione o di «Make new codes»: una volta.
  const [codes, setCodes] = useState<{ first: boolean; codes: string[] } | null>(null);

  let body;
  if (security.isError && !security.data) {
    body = (
      <ReadError message={t("prefs.security.loadError")} onRetry={() => void security.refetch()} />
    );
  } else if (security.isPending) {
    body = <RowsSkeleton parts={3} />;
  } else {
    const s = security.data;
    body = (
      <>
        <StatusLine
          security={s}
          setupOpen={setupOpen}
          onSetUp={() => {
            setSetupOpen(true);
            appPart.current?.scrollIntoView?.({ block: "start" });
          }}
        />
        <AppPart
          partRef={appPart}
          security={s}
          open={setupOpen}
          onOpen={() => setSetupOpen(true)}
          onClose={() => setSetupOpen(false)}
          onFirstCodes={(c) => setCodes({ first: true, codes: c })}
        />
        {/* Senza l'app (Sara) passkey e codici non ci sono ancora. */}
        {s.totp && <PasskeysPart security={s} />}
        {s.totp && (
          <BackupPart
            security={s}
            codes={codes}
            onCodes={(c) => setCodes({ first: false, codes: c })}
            onDone={() => setCodes(null)}
          />
        )}
        {!s.totp && codes && (
          <Part title={t("prefs.security.backup.title")}>
            <BackupCodes codes={codes} onDone={() => setCodes(null)} />
          </Part>
        )}
        <SessionsPart sessions={s.sessions} />
        <LogPart events={s.events} />
      </>
    );
  }

  return (
    <PrefsPage title={t("prefs.sections.security")} intro={t("prefs.security.intro")}>
      {body}
    </PrefsPage>
  );
}

/** La riga di stato: ✓ «On · authenticator app, 2 passkeys, 7 backup codes left» o ○ «Off». */
function StatusLine({
  security: s,
  setupOpen,
  onSetUp,
}: {
  security: MySecurity;
  setupOpen: boolean;
  onSetUp: () => void;
}) {
  const { t } = useTranslation();
  if (s.on) {
    const methods = [
      t("prefs.security.appShort"),
      ...(s.passkeys.length > 0
        ? [t("prefs.security.passkeysCount", { count: s.passkeys.length })]
        : []),
      t("prefs.security.codesLeft", { count: s.backupCodesLeft }),
    ].join(", ");
    return (
      <div data-security-status="on" className="mt-6 flex flex-col gap-1">
        <p className="flex items-center gap-2 text-lg font-semibold text-ink">
          <span className="text-positive">
            <CheckGlyph />
          </span>
          {t("prefs.security.statusOn", { methods })}
        </p>
        <p className="pl-6 text-sm text-ink-muted">{t("prefs.security.staysOn")}</p>
      </div>
    );
  }
  return (
    <div data-security-status="off" className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex items-center gap-2 text-lg font-semibold text-ink">
          <span className="text-ink-muted">
            <OpenCircleGlyph size={16} />
          </span>
          {t("prefs.security.statusOff")}
        </p>
        <p className="pl-6 text-sm text-ink-muted">{t("prefs.security.offBody")}</p>
      </div>
      {!setupOpen && (
        <button type="button" className={primaryButton} onClick={onSetUp}>
          {t("prefs.security.setUpNow")}
        </button>
      )}
    </div>
  );
}

// --- l'app di autenticazione -------------------------------------------------

type Failure =
  | { kind: "wrong"; triesLeft: number }
  | { kind: "locked"; until: string }
  | { kind: "failed" };

function AppPart({
  partRef,
  security: s,
  open,
  onOpen,
  onClose,
  onFirstCodes,
}: {
  partRef: React.Ref<HTMLElement>;
  security: MySecurity;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onFirstCodes: (codes: string[]) => void;
}) {
  const { t } = useTranslation();
  const date = useDateLabel();
  const toast = useToast();
  const reauth = useReauth();
  const startFirst = useStartFirstTotpSetup();
  const startAgain = useStartTotpSetup();
  const confirm = useConfirmTotp();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [updated, setUpdated] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const first = !s.totp;
  const locked = failure?.kind === "locked";

  // Aprire la configurazione prepara la chiave: per la prima volta senza
  // riconferma (non c'è ancora un secondo fattore), per riconfigurare con.
  async function start() {
    setStartFailed(false);
    setFailure(null);
    setCode("");
    setUpdated(false);
    try {
      if (first) {
        setSetup(await startFirst.mutateAsync(undefined));
        return;
      }
      const r = await reauth(() => startAgain.mutateAsync(undefined), {
        action: t("prefs.reauth.reconfigure"),
      });
      const refusal = refusalOf(r);
      if (!refusal) return setSetup((r as { setup: TotpSetup }).setup);
      onClose();
      if (refusal.error !== "reauth_cancelled") setStartFailed(true);
    } catch {
      setStartFailed(true);
    }
  }

  // «Set up now» (dalla riga di stato) apre e prepara; una volta sola per apertura.
  const started = useRef(false);
  useEffect(() => {
    if (!open) {
      started.current = false;
      return;
    }
    if (started.current) return;
    started.current = true;
    void start();
  }, [open]);

  useEffect(() => {
    if (setup) field.current?.focus();
  }, [setup]);

  const close = () => {
    setSetup(null);
    setCode("");
    setFailure(null);
    onClose();
    opener.current?.focus();
  };

  function check(value: string, e?: FormEvent) {
    e?.preventDefault();
    if (confirm.isPending || locked) return;
    setFailure(null);
    confirm.mutate(value, {
      onSuccess: (r) => {
        if (r.ok) {
          setSetup(null);
          setCode("");
          onClose();
          if (r.backupCodes) onFirstCodes(r.backupCodes);
          else {
            setUpdated(true);
            toast.show(t("prefs.security.app.updated"));
          }
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

  const status = s.totp
    ? s.totpSince
      ? t("prefs.security.app.since", { date: date(s.totpSince) })
      : t("prefs.security.app.sinceUnknown")
    : t("prefs.security.app.notSet");
  const busy = startFirst.isPending || startAgain.isPending;

  return (
    <Part
      partRef={partRef}
      title={t("prefs.security.app.title")}
      action={
        !open && (
          <button ref={opener} type="button" className={secondaryButton} onClick={onOpen}>
            {s.totp ? t("prefs.security.app.reconfigure") : t("prefs.security.app.setUp")}
          </button>
        )
      }
    >
      <p className="text-md text-ink-muted">{status}</p>
      {updated && (
        <p role="status" className="mt-1 text-sm text-ink">
          {t("prefs.security.app.updated")}
        </p>
      )}
      {startFailed && (
        <div className="mt-2">
          <WriteError message={t("prefs.security.app.startFailed")} onRetry={onOpen} />
        </div>
      )}
      {open && (
        <Reveal>
          <div
            className="mt-4 flex flex-col gap-4"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
          >
            {!setup ? (
              <p className="text-sm text-ink-muted" aria-busy={busy}>
                {t("taskUi.states.loading")}
              </p>
            ) : (
              <>
                {!first && (
                  <p className="text-sm text-ink">{t("prefs.security.app.keepsWorking")}</p>
                )}
                <div className="flex flex-wrap items-start gap-6">
                  <figure className="flex flex-col items-start gap-1.5">
                    <div
                      className="size-40 rounded-md border border-rule bg-white p-2 text-black [&>svg]:size-full"
                      role="img"
                      aria-label={t("prefs.security.app.qrLabel")}
                      dangerouslySetInnerHTML={{ __html: setup.qrSvg }}
                    />
                    <figcaption className="text-xs text-ink-muted">
                      {t("prefs.security.app.qrNote")}
                    </figcaption>
                  </figure>
                  <form
                    noValidate
                    onSubmit={(e) => check(code, e)}
                    className="flex min-w-[220px] flex-1 flex-col gap-3"
                  >
                    <p className="text-sm text-ink">{t("prefs.security.app.scan")}</p>
                    <div className="max-w-[200px]">
                      <TotpInput
                        label={t("prefs.security.app.firstCode")}
                        inputRef={field}
                        value={code}
                        disabled={locked}
                        error={
                          failure?.kind === "wrong" ? wrongCodeMessage(t, failure.triesLeft) : null
                        }
                        onChange={setCode}
                      />
                    </div>
                    {failure?.kind === "failed" && (
                      <WriteError message={t("prefs.security.app.failed")} />
                    )}
                    {failure?.kind === "locked" && <LockedBlock until={failure.until} />}
                    <div className="flex gap-2">
                      {!locked && (
                        <button
                          type="submit"
                          className={primaryButton}
                          aria-busy={confirm.isPending}
                        >
                          <BusyLabel
                            busy={confirm.isPending}
                            idle={t("prefs.security.app.confirm")}
                            pending={t("prefs.security.app.confirming")}
                          />
                        </button>
                      )}
                      <button type="button" className={secondaryButton} onClick={close}>
                        {t("prefs.security.app.cancel")}
                      </button>
                    </div>
                  </form>
                </div>
                <SecretOnce title={t("prefs.security.app.cantScan")} value={setup.secret} />
                <PrototypeBox>
                  <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 text-sm">
                    <dt className="text-ink-muted">{t("entry.prototype.code")}</dt>
                    <dd className="font-code text-ink">123456</dd>
                  </dl>
                </PrototypeBox>
              </>
            )}
          </div>
        </Reveal>
      )}
    </Part>
  );
}

// --- le passkey --------------------------------------------------------------

function PasskeysPart({ security: s }: { security: MySecurity }) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const lastWithoutApp = s.passkeys.length === 1 && !s.totp;
  return (
    <Part
      title={t("prefs.security.passkeys.title")}
      action={
        !adding && (
          <button
            ref={addButton}
            type="button"
            className={secondaryButton}
            onClick={() => setAdding(true)}
          >
            {t("prefs.security.passkeys.add")}
          </button>
        )
      }
    >
      {adding && (
        <Reveal>
          <AddPasskey
            onClose={() => {
              setAdding(false);
              window.setTimeout(() => addButton.current?.focus(), 0);
            }}
          />
        </Reveal>
      )}
      {s.passkeys.length === 0 ? (
        !adding && <p className="text-md text-ink-muted">{t("prefs.security.passkeys.empty")}</p>
      ) : (
        <ul>
          {s.passkeys.map((k) => (
            <PasskeyRow key={k.id} passkey={k} removable={!lastWithoutApp} />
          ))}
        </ul>
      )}
    </Part>
  );
}

function AddPasskey({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const reauth = useReauth();
  const add = useAddPasskey();
  const [name, setName] = useState("");
  const [step, setStep] = useState<"name" | "browser">("name");
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  function next(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError(t("prefs.security.passkeys.nameEmpty"));
    setError(null);
    setStep("browser");
  }

  // Il browser risponde (nel prototipo, dal riquadro); prima la riconferma, se serve.
  async function answer(simulate: "ok" | "fail") {
    setFailed(false);
    try {
      const r = await reauth(() => add.mutateAsync({ name: name.trim(), simulate }), {
        action: t("prefs.reauth.addPasskey"),
      });
      const refusal = refusalOf(r);
      if (!refusal) {
        toast.show(t("prefs.security.passkeys.added", { name: name.trim() }));
        return onClose();
      }
      if (refusal.error === "reauth_cancelled") return;
      if (refusal.reason === "name") {
        setStep("name");
        return setError(t("prefs.security.passkeys.nameEmpty"));
      }
      setFailed(true);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div
      className="mb-4 flex flex-col gap-3 border-b border-rule pb-5"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      {step === "name" ? (
        <form noValidate onSubmit={next} className="flex flex-col gap-3">
          <div className="max-w-[320px]">
            <EntryField
              label={t("prefs.security.passkeys.nameLabel")}
              placeholder={t("prefs.security.passkeys.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              error={error}
              maxLength={60}
              autoFocus
            />
          </div>
          <div className="flex gap-2">
            <button type="submit" className={primaryButton}>
              {t("prefs.security.passkeys.continue")}
            </button>
            <button type="button" className={secondaryButton} onClick={onClose}>
              {t("prefs.security.passkeys.cancel")}
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="text-md text-ink">{t("prefs.security.passkeys.browserAsks")}</p>
          {failed && <WriteError message={t("prefs.security.passkeys.failed")} />}
          <PrototypeBox>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={secondaryButton}
                disabled={add.isPending}
                onClick={() => void answer("ok")}
              >
                {t("prefs.security.passkeys.simulate")}
              </button>
              <button
                type="button"
                className={secondaryButton}
                disabled={add.isPending}
                onClick={() => void answer("fail")}
              >
                {t("prefs.security.passkeys.simulateFail")}
              </button>
            </div>
          </PrototypeBox>
          <div>
            <button type="button" className={secondaryButton} onClick={onClose}>
              {t("prefs.security.passkeys.cancel")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function PasskeyRow({ passkey: k, removable }: { passkey: Passkey; removable: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const date = useDateLabel();
  const day = useDayWord();
  const reauth = useReauth();
  const rename = useRenamePasskey();
  const remove = useRemovePasskey();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(k.name);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<"rename" | "remove" | null>(null);
  const renameButton = useRef<HTMLButtonElement>(null);

  const meta = k.lastUsedAt
    ? t("prefs.security.passkeys.meta", { added: date(k.addedAt), used: day(k.lastUsedAt) })
    : t("prefs.security.passkeys.metaNever", { added: date(k.addedAt) });

  const stopEditing = () => {
    setEditing(false);
    window.setTimeout(() => renameButton.current?.focus(), 0);
  };
  function save() {
    const name = draft.trim();
    if (!name || name === k.name) return stopEditing();
    setError(null);
    rename.mutate(
      { id: k.id, name },
      {
        onSuccess: (r) => (refusalOf(r) ? setError("rename") : stopEditing()),
        onError: () => setError("rename"),
      },
    );
  }

  async function doRemove() {
    setRemoving(false);
    setError(null);
    try {
      const r = await reauth(() => remove.mutateAsync(k.id), {
        action: t("prefs.reauth.removePasskey", { name: k.name }),
      });
      const refusal = refusalOf(r);
      if (!refusal) return toast.show(t("prefs.security.passkeys.removed", { name: k.name }));
      if (refusal.error !== "reauth_cancelled") setError("remove");
    } catch {
      setError("remove");
    }
  }

  return (
    <li className="border-b border-rule last:border-b-0">
      <div className="flex min-h-10 items-center gap-3 py-1">
        {editing ? (
          <input
            aria-label={t("prefs.security.passkeys.renameLabel", { name: k.name })}
            value={draft}
            autoFocus
            maxLength={60}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDraft(k.name);
                stopEditing();
              }
            }}
            onBlur={save}
            className={`${inputClass} h-8 max-w-[280px] py-1`}
          />
        ) : (
          <span className="flex min-w-0 flex-1 flex-col">
            <span title={k.name} className="truncate text-md text-ink">
              {k.name}
            </span>
          </span>
        )}
        <span className="num ml-auto shrink-0 text-sm text-ink-muted">{meta}</span>
        {!editing && (
          <button
            ref={renameButton}
            type="button"
            className={rowButton}
            aria-label={`${t("prefs.security.passkeys.rename")} ${k.name}`}
            onClick={() => {
              setDraft(k.name);
              setEditing(true);
            }}
          >
            {t("prefs.security.passkeys.rename")}
          </button>
        )}
        {removing ? (
          <ArmedButton
            label={t("prefs.security.passkeys.remove")}
            sureLabel={t("prefs.security.passkeys.removeSure")}
            autoArm
            onDisarm={() => setRemoving(false)}
            onConfirm={() => void doRemove()}
          />
        ) : (
          <RowMenu label={t("prefs.security.passkeys.more", { name: k.name })}>
            {(close) =>
              removable ? (
                <RowMenuItem
                  onSelect={() => {
                    close(false);
                    setRemoving(true);
                  }}
                >
                  {t("prefs.security.passkeys.remove")}
                </RowMenuItem>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  aria-disabled="true"
                  title={t("prefs.security.passkeys.lastNeedsApp")}
                  className="flex min-h-8 w-full flex-col items-start rounded-md px-2 py-1 text-left text-sm text-ink-faint"
                >
                  {t("prefs.security.passkeys.remove")}
                  <span className="text-xs">{t("prefs.security.passkeys.lastNeedsApp")}</span>
                </button>
              )
            }
          </RowMenu>
        )}
      </div>
      {error && (
        <div className="pb-2">
          <WriteError
            message={
              error === "rename"
                ? t("prefs.security.passkeys.renameFailed")
                : t("prefs.security.passkeys.removeFailed")
            }
            onRetry={error === "rename" ? save : () => void doRemove()}
          />
        </div>
      )}
    </li>
  );
}

// --- i codici di backup -------------------------------------------------------

function BackupCodes({
  codes,
  onDone,
}: {
  codes: { first: boolean; codes: string[] };
  onDone: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SecretOnce
      title={
        codes.first ? t("prefs.security.backup.firstTitle") : t("prefs.security.backup.newTitle")
      }
      value={codes.codes.join("\n")}
      layout="codes"
      download="stubwise-backup-codes.txt"
      onDone={onDone}
    >
      <p>{t("prefs.security.backup.each")}</p>
    </SecretOnce>
  );
}

function BackupPart({
  security: s,
  codes,
  onCodes,
  onDone,
}: {
  security: MySecurity;
  codes: { first: boolean; codes: string[] } | null;
  onCodes: (codes: string[]) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const reauth = useReauth();
  const regenerate = useRegenerateBackupCodes();
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState(false);
  const few = s.backupCodesLeft <= 3;

  async function make() {
    setAsking(false);
    setFailed(false);
    try {
      const r = await reauth(() => regenerate.mutateAsync(undefined), {
        action: t("prefs.reauth.backupCodes"),
      });
      const refusal = refusalOf(r);
      if (!refusal) return onCodes((r as { codes: string[] }).codes);
      if (refusal.error !== "reauth_cancelled") setFailed(true);
    } catch {
      setFailed(true);
    }
  }

  return (
    <Part
      title={t("prefs.security.backup.title")}
      action={
        !asking &&
        !codes && (
          <button type="button" className={secondaryButton} onClick={() => setAsking(true)}>
            {t("prefs.security.backup.make")}
          </button>
        )
      }
    >
      {codes ? (
        <BackupCodes codes={codes} onDone={onDone} />
      ) : (
        <div className="flex flex-col gap-2">
          <p className="num text-md text-ink-muted">
            {t("prefs.security.backup.left", {
              count: s.backupCodesLeft,
              total: s.backupCodesTotal,
            })}
          </p>
          {few && (
            <p className="flex items-start gap-1.5 text-sm text-ink">
              <span className="mt-0.5 text-warning">
                <TriangleGlyph />
              </span>
              {t("prefs.security.backup.few")}
            </p>
          )}
          {asking && (
            <Reveal>
              <div
                role="group"
                aria-label={t("prefs.security.backup.make")}
                className="flex flex-wrap items-center gap-3 pt-1"
              >
                <p className="text-md text-ink">{t("prefs.security.backup.sure")}</p>
                <button
                  type="button"
                  autoFocus
                  className={`${secondaryButton} text-critical`}
                  onClick={() => void make()}
                >
                  {t("prefs.security.backup.makeConfirm")}
                </button>
                <button type="button" className={rowButton} onClick={() => setAsking(false)}>
                  {t("prefs.security.backup.cancel")}
                </button>
              </div>
            </Reveal>
          )}
          {failed && (
            <WriteError message={t("prefs.security.backup.failed")} onRetry={() => void make()} />
          )}
        </div>
      )}
    </Part>
  );
}

// --- le sessioni e il registro ------------------------------------------------

function SessionsPart({ sessions }: { sessions: Session[] }) {
  const { t } = useTranslation();
  const others = sessions.filter((x) => !x.current);
  return (
    <Part title={t("prefs.security.sessions.title")}>
      <ul>
        {sessions.map((x) => (
          <SessionRow key={x.id} session={x} />
        ))}
      </ul>
      {others.length === 0 && (
        <p className="pt-1 text-sm text-ink-muted">{t("prefs.security.sessions.none")}</p>
      )}
    </Part>
  );
}

function SessionRow({ session: x }: { session: Session }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const end = useEndSession();
  const [failed, setFailed] = useState(false);
  const device = t(`prefs.security.sessions.${x.device.kind}`, { detail: x.device.detail });
  // Oggi l'ora («10:00»), prima la data con l'ora («Oct 26, 18:30»).
  const last = x.current
    ? t("prefs.security.sessions.activeNow")
    : whenWithTime(x.lastUsedAt, i18n.language);

  const signOut = () => {
    setFailed(false);
    end.mutate(x.id, {
      onSuccess: (r) =>
        refusalOf(r)
          ? setFailed(true)
          : toast.show(t("prefs.security.sessions.signedOut", { device })),
      onError: () => setFailed(true),
    });
  };

  return (
    <li className={rowClass}>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-md text-ink">{device}</span>
        {x.current && (
          <span className="shrink-0 text-sm text-ink-muted">
            {t("prefs.security.sessions.thisDevice")}
          </span>
        )}
      </span>
      <span className="num shrink-0 text-sm text-ink-muted">{last}</span>
      {!x.current && (
        <button
          type="button"
          className={rowButton}
          disabled={end.isPending}
          aria-label={t("prefs.security.sessions.signOutOf", { device })}
          onClick={signOut}
        >
          {t("prefs.security.sessions.signOut")}
        </button>
      )}
      {failed && <WriteError message={t("prefs.security.sessions.failed")} onRetry={signOut} />}
    </li>
  );
}

/** Il registro della sicurezza: lo usano anche la pagina di una persona (Amministrazione). */
export function LogPart({ events }: { events: MySecurity["events"] }) {
  const { t, i18n } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, LOG_FIRST);
  return (
    <Part title={t("prefs.security.log.title")}>
      {events.length === 0 ? (
        <p className="text-md text-ink-muted">{t("prefs.security.log.empty")}</p>
      ) : (
        <>
          <ol>
            {shown.map((e) => {
              const what = t(`prefs.security.log.kinds.${e.kind}`);
              return (
                <li
                  key={e.id}
                  className="flex min-h-9 items-baseline gap-4 border-b border-rule py-2 last:border-b-0"
                >
                  <time dateTime={e.at} className="num w-28 shrink-0 text-sm text-ink-muted">
                    {formatDateTime(e.at, i18n.language)}
                  </time>
                  <span className="min-w-0 text-md text-ink">
                    {e.byName ? t("prefs.security.log.byName", { what, name: e.byName }) : what}
                  </span>
                </li>
              );
            })}
          </ol>
          {events.length > LOG_FIRST && (
            <button
              type="button"
              className={`${rowButton} mt-2 -ml-2`}
              aria-expanded={all}
              onClick={() => setAll((v) => !v)}
            >
              {all
                ? t("prefs.security.log.showFewer")
                : t("prefs.security.log.showAll", { count: events.length })}
            </button>
          )}
        </>
      )}
    </Part>
  );
}
