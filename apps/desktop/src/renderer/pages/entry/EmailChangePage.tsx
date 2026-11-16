import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmEmailChange } from "../../data/queries";
import { EntryColumn, EntryHeading, ErrorLine, textButton } from "./parts";

/**
 * `/email-change/$token` (area 9, R2; il server manda il link a
 * `<PUBLIC_URL>/app/#/email-change/<token>`): pubblica, senza sessione. Si
 * conferma da sola all'apertura, UNA volta: la prova è aver ricevuto il link.
 * Un link sbagliato, scaduto, usato o annullato dice una frase sola, senza
 * nomi; un indirizzo preso nel frattempo lo dice, e l'email resta com'era.
 */
export function EmailChangePage({ token }: { token: string }) {
  const { t } = useTranslation();
  const confirm = useConfirmEmailChange();
  const sent = useRef(false);

  useEffect(() => {
    // Una conferma sola, anche col doppio montaggio dello StrictMode.
    if (sent.current) return;
    sent.current = true;
    confirm.mutate(token);
  }, [token]);

  const result = confirm.data;
  const reason = result && !result.ok && "reason" in result ? result.reason : null;
  const goToSignIn = (
    <Link to="/login" className={`${textButton} text-sm`}>
      {t("entry.register.goToSignIn")}
    </Link>
  );

  return (
    <EntryColumn>
      {confirm.isError ? (
        <>
          <EntryHeading title={t("entry.emailChange.title")} />
          <ErrorLine>{t("entry.emailChange.failed")}</ErrorLine>
        </>
      ) : !result ? (
        <div aria-busy="true" aria-label={t("entry.emailChange.confirming")} className="mb-6">
          <div className="h-8 w-56 animate-pulse rounded-md bg-ink/8 motion-reduce:animate-none" />
        </div>
      ) : result.ok ? (
        <section>
          <EntryHeading
            title={t("entry.emailChange.title")}
            lead={t("entry.emailChange.done", { email: result.email })}
          />
          {goToSignIn}
        </section>
      ) : reason === "email_taken" ? (
        <section>
          <EntryHeading
            title={t("entry.emailChange.takenTitle")}
            lead={t("entry.emailChange.takenBody")}
          />
          {goToSignIn}
        </section>
      ) : (
        <section>
          <EntryHeading
            title={t("entry.emailChange.invalidTitle")}
            lead={t("entry.emailChange.invalidBody")}
          />
          {goToSignIn}
        </section>
      )}
    </EntryColumn>
  );
}
