import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "./api";
import { useReauthRun } from "./reauth";
import { BusyLabel, CodeInput, ErrorLine, Heading, Notice, errorKey, formatDateTime, primaryButton, secondaryButton } from "./ui";

// `#/recover` della pagina a sé (solo full admin, con la riconferma; design
// «Kit di recupero» e §10): il testo incollato va al worker e lascia subito
// la pagina; al server solo la prova. Il kit serve SOLO a confermare accessi
// in attesa, una persona alla volta, con una presenza fresca per conferma
// (I-1), e non mostra mai una password. «Done» o lasciare la pagina lo
// dimenticano; il worker lo butta comunque dopo 10 minuti e a ogni chiusura.

export function RecoverPage({ me }: { me: api.Me }) {
  const { t } = useTranslation();
  return (
    <>
      <Heading title={t("vault.setup.recovery.title")} lead={t("vault.setup.recovery.subtitle")} />
      {me.fullAdmin ? <Recovery /> : <ErrorLine>{t("vault.setup.errors.forbidden")}</ErrorLine>}
    </>
  );
}

function Recovery() {
  const { t, i18n } = useTranslation();
  const { run, panel } = useReauthRun();
  const [text, setText] = useState("");
  const [items, setItems] = useState<api.RecoveryPerson[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const loaded = useRef(false);

  useEffect(
    () => () => {
      if (loaded.current) void api.forgetRecoveryKit();
    },
    [],
  );

  async function use() {
    const kitText = text;
    // Letto: il testo esce dallo stato della pagina; lo tiene il worker.
    setText("");
    setError(null);
    setBusy("load");
    const out = await run(() => api.loadRecoveryKit(kitText));
    setBusy(null);
    if (out.ok) {
      loaded.current = true;
      setItems(out.items);
    } else if (out.code !== "reauth_cancelled") setError(out.code);
  }

  async function confirm(person: api.RecoveryPerson, withCode?: string) {
    setError(null);
    setNotice(null);
    setBusy(person.personKeyId);
    const out = await api.confirmWithRecoveryKit(person.personKeyId, withCode);
    setBusy(null);
    setCode("");
    if (!out.ok && out.code === "code_required") return setCodeFor(person.personKeyId);
    setCodeFor(null);
    if (out.ok) {
      const skipped = out.keyChanged + out.notAllowed;
      setNotice(
        [
          t("vault.setup.recovery.saved", { count: out.saved, name: person.email }),
          ...(skipped > 0 ? [t("vault.setup.recovery.skipped", { count: skipped })] : []),
        ].join(" "),
      );
      setItems((current) => out.items ?? current?.filter((p) => p.personKeyId !== person.personKeyId) ?? null);
    } else {
      // Kit scaduto o buttato (10 minuti, una chiusura): si ricarica.
      if (out.code === "no_kit") {
        loaded.current = false;
        setItems(null);
      }
      setError(out.code);
    }
  }

  async function done() {
    await api.forgetRecoveryKit();
    loaded.current = false;
    setItems(null);
    setText("");
    setError(null);
    setNotice(null);
  }

  const errorText =
    error === "invalid_kit"
      ? t("vault.setup.recovery.invalidKit")
      : error === "wrong_kit"
        ? t("vault.setup.recovery.wrongKit")
        : error === "no_kit"
          ? t("vault.setup.page.kitExpired")
          : error
            ? t(errorKey(error))
            : null;

  return (
    <section className="flex flex-col gap-3">
      {panel}
      {items ? (
        <div className="flex flex-col gap-3">
          <p className="text-md text-ink">{items.length === 0 ? t("vault.setup.recovery.empty") : t("vault.setup.recovery.loaded")}</p>
          {notice && <Notice>{notice}</Notice>}
          <ul className="flex flex-col">
            {items.map((p) => (
              <li key={p.personKeyId} className="flex flex-col gap-1 border-b border-rule py-3 last:border-b-0">
                <span className="text-md font-medium text-ink">{p.email}</span>
                <span className="text-sm text-ink-muted">
                  {p.device
                    ? t("vault.setup.recovery.key", { created: formatDateTime(p.createdAt, i18n.language), device: p.device })
                    : t("vault.setup.recovery.keyNoDevice", { created: formatDateTime(p.createdAt, i18n.language) })}
                </span>
                <span className="text-sm text-ink-muted">
                  {t("vault.setup.recovery.fingerprint")} <span className="num font-mono text-ink">{p.fingerprint}</span>
                </span>
                <span className="text-sm text-ink-muted">{t("vault.setup.recovery.credentials", { count: p.credentials.length })}</span>
                {codeFor === p.personKeyId && (
                  <>
                    <p className="text-sm text-ink-muted">{t("vault.setup.recovery.codeHint")}</p>
                    <CodeInput label={t("vault.setup.recovery.codeLabel")} value={code} onChange={setCode} />
                  </>
                )}
                <button
                  type="button"
                  className={`${primaryButton} mt-1 self-start`}
                  aria-label={t("vault.setup.recovery.confirmAria", { name: p.email })}
                  disabled={busy !== null || (codeFor === p.personKeyId && code.length !== 6)}
                  onClick={() => void confirm(p, codeFor === p.personKeyId ? code : undefined)}
                >
                  <BusyLabel
                    busy={busy === p.personKeyId}
                    idle={t("vault.setup.recovery.confirm")}
                    pending={t("vault.setup.recovery.confirming")}
                  />
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className={`${secondaryButton} self-start`} onClick={() => void done()}>
            {t("vault.setup.recovery.done")}
          </button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void use();
          }}
        >
          <label htmlFor="vault-recovery-kit" className="text-sm font-medium text-ink">
            {t("vault.setup.recovery.kitLabel")}
          </label>
          <textarea
            id="vault-recovery-kit"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-describedby="vault-recovery-kit-hint"
            autoComplete="off"
            spellCheck={false}
            translate="no"
            data-gramm="false"
            rows={5}
            className="num rounded-md border border-rule-strong bg-ground px-3 py-2 font-mono text-md text-ink"
          />
          <p id="vault-recovery-kit-hint" className="text-sm text-ink-muted">
            {t("vault.setup.recovery.kitHint")}
          </p>
          <button type="submit" className={`${primaryButton} self-start`} disabled={busy !== null || text.trim() === ""}>
            <BusyLabel busy={busy === "load"} idle={t("vault.setup.recovery.use")} pending={t("vault.setup.recovery.using")} />
          </button>
        </form>
      )}
      {errorText && <ErrorLine>{errorText}</ErrorLine>}
    </section>
  );
}
