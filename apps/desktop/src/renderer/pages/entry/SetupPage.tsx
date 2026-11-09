import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  EMAIL_RE,
  MIN_PASSWORD_LENGTH,
  useCreateFirstAdmin,
  useResetPrototype,
} from "../../data/queries";
import { useToast } from "../../tasks-ui/Toast";
import { PrototypeBox } from "../automations/shared";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { BusyLabel, EntryColumn, EntryField, EntryHeading, ErrorLine, textButton } from "./parts";

/**
 * `/setup` (shape `entry.md`): il primo avvio, solo a istanza vuota (il
 * cancello delle rotte ci manda e ne allontana). Crea il primo full admin e
 * lo porta dentro, sulla Home vuota.
 */
export function SetupPage() {
  const { t } = useTranslation();
  const create = useCreateFirstAdmin();
  const resetPrototype = useResetPrototype();
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [tried, setTried] = useState(false);

  const nameError = tried && !name.trim() ? t("entry.register.nameMissing") : null;
  const emailError = tried && !EMAIL_RE.test(email.trim()) ? t("entry.setup.emailInvalid") : null;
  const passwordError =
    tried && password.length < MIN_PASSWORD_LENGTH ? t("entry.register.tooShort") : null;
  const confirmError =
    tried && !passwordError && confirm !== password ? t("entry.register.mismatch") : null;

  function submit(e?: FormEvent) {
    e?.preventDefault();
    setTried(true);
    if (
      !name.trim() ||
      !EMAIL_RE.test(email.trim()) ||
      password.length < MIN_PASSWORD_LENGTH ||
      confirm !== password
    )
      return;
    // `mutateAsync`: appena la persona è dentro, il cancello delle rotte
    // lascia `/setup` e la pagina si smonta; il messaggio parte lo stesso.
    create
      .mutateAsync({ name: name.trim(), email: email.trim(), password })
      .then((r) => {
        if (!r.ok) return;
        if (!r.signedIn) {
          // L'account c'è, il login subito dopo no: si entra dal login.
          void navigate({ to: "/login", replace: true });
          toast.show(t("entry.register.createdSignIn"));
          return;
        }
        void navigate({ to: "/home", replace: true });
        toast.show(t("entry.setup.done"));
      })
      .catch(() => {
        /* l'errore lo mostra `create.isError` */
      });
  }

  return (
    <EntryColumn>
      <EntryHeading title={t("entry.setup.title")} lead={t("entry.setup.lead")} />
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <EntryField
          label={t("entry.register.name")}
          autoComplete="name"
          autoFocus
          value={name}
          error={nameError}
          onChange={(e) => setName(e.target.value)}
        />
        <EntryField
          label={t("entry.login.email")}
          type="email"
          autoComplete="email"
          value={email}
          error={emailError}
          onChange={(e) => setEmail(e.target.value)}
        />
        <EntryField
          label={t("entry.register.password")}
          type="password"
          autoComplete="new-password"
          value={password}
          error={passwordError}
          onChange={(e) => setPassword(e.target.value)}
        />
        <EntryField
          label={t("entry.register.confirm")}
          type="password"
          autoComplete="new-password"
          value={confirm}
          error={confirmError}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {(create.isError || (create.data && !create.data.ok)) && (
          <ErrorLine
            action={
              <button type="button" className={`${textButton} ml-1`} onClick={() => submit()}>
                {t("taskUi.states.retry")}
              </button>
            }
          >
            {t("entry.setup.failed")}
          </ErrorLine>
        )}
        <div className="flex justify-end">
          <button type="submit" className={primaryButton} aria-busy={create.isPending}>
            <BusyLabel
              busy={create.isPending}
              idle={t("entry.setup.submit")}
              pending={t("entry.register.submitting")}
            />
          </button>
        </div>
      </form>
      <div className="mt-10">
        <PrototypeBox>
          <p className="text-sm text-ink">{t("entry.prototype.emptyInstance")}</p>
          <div>
            <button
              type="button"
              className={secondaryButton}
              onClick={() => {
                resetPrototype();
                void navigate({ to: "/home", replace: true });
              }}
            >
              {t("entry.menu.resetPrototype")}
            </button>
          </div>
        </PrototypeBox>
      </div>
    </EntryColumn>
  );
}
