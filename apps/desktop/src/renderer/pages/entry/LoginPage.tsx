import { Navigate, useNavigate } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  useEntryGate,
  useLogin,
  usePrototypeAccounts,
  useSimulateInviteLink,
  resetTokenOf,
} from "../../data/queries";
import { inputClass } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { PrototypeBox } from "../automations/shared";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { BusyLabel, EntryColumn, EntryField, EntryHeading, ErrorLine, textButton } from "./parts";
import { SecondFactorStep } from "./SecondFactorStep";

/** La password di ogni persona del seme e il codice fisso, mostrati nel riquadro del prototipo. */
const PROTOTYPE_PASSWORD = "stubwise";
const PROTOTYPE_CODE = "123456";

/**
 * `/login` (shape `entry.md`): email e password, poi — per chi ha un secondo
 * fattore — il passo del codice nella stessa colonna. Un errore non dice mai
 * se l'email esiste. Chi è già dentro va alla Home; chi è a metà (il secondo
 * passo aperto, l'app ricaricata) riparte dal codice.
 */
export function LoginPage() {
  const { stage } = useEntryGate();
  const [step, setStep] = useState<"credentials" | "second_factor">(
    stage === "second_factor" ? "second_factor" : "credentials",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Dentro, ma con un passo ancora da mostrare (i codici di backup quasi finiti).
  const [finishing, setFinishing] = useState(false);
  const navigate = useNavigate();

  if (stage === "in" && !finishing) return <Navigate to="/home" replace />;

  return (
    <EntryColumn>
      {/* La dissolvenza fra i due passi sta sul blocco; il logo resta fermo. */}
      <div key={step} className="entry-enter">
        {step === "credentials" ? (
          <CredentialsStep
            email={email}
            password={password}
            onEmail={setEmail}
            onPassword={setPassword}
            onSecondFactor={() => {
              setPassword("");
              setStep("second_factor");
            }}
          />
        ) : (
          <SecondFactorStep
            email={email}
            onBack={() => setStep("credentials")}
            onFinishing={setFinishing}
            onDone={() => void navigate({ to: "/home", replace: true })}
          />
        )}
      </div>
      {step === "credentials" && (
        <LoginPrototypeBox
          onPick={(account) => {
            setEmail(account.email);
            setPassword(PROTOTYPE_PASSWORD);
          }}
        />
      )}
    </EntryColumn>
  );
}

function CredentialsStep({
  email,
  password,
  onEmail,
  onPassword,
  onSecondFactor,
}: {
  email: string;
  password: string;
  onEmail: (v: string) => void;
  onPassword: (v: string) => void;
  onSecondFactor: () => void;
}) {
  const { t } = useTranslation();
  const login = useLogin();
  const navigate = useNavigate();
  const passwordRef = useRef<HTMLInputElement>(null);
  const [wrong, setWrong] = useState(false);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (login.isPending) return;
    setWrong(false);
    login.mutate(
      { email, password },
      {
        onSuccess: (r) => {
          if (!r.ok) {
            // La stessa frase per un'email che non esiste, una password
            // sbagliata, una persona disattivata. L'email resta.
            setWrong(true);
            onPassword("");
            passwordRef.current?.focus();
          } else if (r.stage === "second_factor") onSecondFactor();
          else void navigate({ to: "/home", replace: true });
        },
      },
    );
  }

  return (
    <>
      <EntryHeading title={t("entry.login.title")} lead={t("entry.login.lead")} />
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <EntryField
          label={t("entry.login.email")}
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(e) => onEmail(e.target.value)}
        />
        <EntryField
          label={t("entry.login.password")}
          type="password"
          autoComplete="current-password"
          inputRef={passwordRef}
          value={password}
          onChange={(e) => onPassword(e.target.value)}
        />
        {wrong && <ErrorLine>{t("entry.login.wrong")}</ErrorLine>}
        {login.isError && (
          <ErrorLine
            action={
              <button type="button" className={`${textButton} ml-1`} onClick={() => submit()}>
                {t("taskUi.states.retry")}
              </button>
            }
          >
            {t("entry.login.failed")}
          </ErrorLine>
        )}
        <div className="flex justify-end">
          {/* Largo uguale durante l'invio: le due etichette occupano la stessa cella. */}
          <button type="submit" className={primaryButton} aria-busy={login.isPending}>
            <BusyLabel
              busy={login.isPending}
              idle={t("entry.login.submit")}
              pending={t("entry.login.submitting")}
            />
          </button>
        </div>
      </form>
    </>
  );
}

/**
 * Il riquadro «Prototype only» del login [IN 2]: la password del seme e il
 * codice fisso (sono «token e chiavi»: monospace), le persone attive del
 * «vedi come» — un clic riempie il modulo, non invia — e «Try an invite»,
 * perché nell'app non c'è una barra degli indirizzi da cui aprire un link.
 */
function LoginPrototypeBox({ onPick }: { onPick: (account: { email: string }) => void }) {
  const { t } = useTranslation();
  const { data: accounts = [] } = usePrototypeAccounts();
  const simulate = useSimulateInviteLink();
  const navigate = useNavigate();
  const toast = useToast();
  const [link, setLink] = useState("");
  const [resetLink, setResetLink] = useState("");

  function openInvite(which: "pending" | "expired") {
    simulate.mutate(which, {
      onSuccess: (r) => {
        if (r) void navigate({ to: "/register/$token", params: { token: r.token } });
        else toast.show(t("entry.prototype.noInvite"));
      },
      onError: () => toast.error(t("entry.prototype.inviteFailed")),
    });
  }

  function openLink(e: FormEvent) {
    e.preventDefault();
    const token = link.trim().split("invite=").at(-1)?.trim();
    if (token) void navigate({ to: "/register/$token", params: { token } });
  }

  // Il link di reset della password (area 9a): lo crea un amministratore in
  // People e lo manda; qui si incolla, come quello d'invito.
  function openResetLink(e: FormEvent) {
    e.preventDefault();
    const token = resetTokenOf(resetLink.trim()).trim();
    if (token) void navigate({ to: "/reset-password/$token", params: { token } });
  }

  return (
    <div className="mt-10">
      <PrototypeBox>
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-ink-muted">{t("entry.prototype.password")}</dt>
          <dd className="font-code text-ink">{PROTOTYPE_PASSWORD}</dd>
          <dt className="text-ink-muted">{t("entry.prototype.code")}</dt>
          <dd className="font-code text-ink">{PROTOTYPE_CODE}</dd>
        </dl>
        {accounts.length > 0 && (
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-ink-muted">{t("entry.prototype.signInAs")}</span>
            <ul className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              {accounts.map((a, i) => (
                <li key={a.personId} className="flex items-baseline gap-2">
                  {i > 0 && (
                    <span aria-hidden="true" className="text-ink-faint">
                      ·
                    </span>
                  )}
                  <button
                    type="button"
                    className={textButton}
                    title={a.email}
                    onClick={() => onPick(a)}
                  >
                    {a.name.split(" ")[0]}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-ink-muted">
          <span>{t("entry.prototype.tryInvite")}</span>
          <button type="button" className={textButton} onClick={() => openInvite("pending")}>
            {t("entry.prototype.pendingInvite")}
          </button>
          <span aria-hidden="true">·</span>
          <button type="button" className={textButton} onClick={() => openInvite("expired")}>
            {t("entry.prototype.expiredInvite")}
          </button>
        </p>
        <p className="-mt-1 text-xs text-ink-muted">{t("entry.prototype.inviteNote")}</p>
        <form onSubmit={openLink} className="flex items-center gap-2">
          <input
            aria-label={t("entry.prototype.inviteLink")}
            placeholder={t("entry.prototype.inviteLinkPlaceholder")}
            value={link}
            onChange={(e) => setLink(e.target.value)}
            className={`${inputClass} h-8 text-sm`}
          />
          <button type="submit" className={secondaryButton} disabled={!link.trim()}>
            {t("entry.prototype.openLink")}
          </button>
        </form>
        <form onSubmit={openResetLink} className="flex items-center gap-2">
          <input
            aria-label={t("entry.prototype.resetLink")}
            placeholder={t("entry.prototype.resetLinkPlaceholder")}
            value={resetLink}
            onChange={(e) => setResetLink(e.target.value)}
            className={`${inputClass} h-8 text-sm`}
          />
          <button type="submit" className={secondaryButton} disabled={!resetLink.trim()}>
            {t("entry.prototype.openLink")}
          </button>
        </form>
      </PrototypeBox>
    </div>
  );
}
