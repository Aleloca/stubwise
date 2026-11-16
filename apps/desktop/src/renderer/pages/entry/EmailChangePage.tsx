import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useConfirmEmailChange, useEmailChangeLink } from "../../data/queries";
import { primaryButton } from "../tasks/controls";
import { BusyLabel, EntryColumn, EntryHeading, ErrorLine, textButton } from "./parts";

/**
 * `/email-change/$token` (area 9, R2; il server manda il link a
 * `<PUBLIC_URL>/app/#/email-change/<token>`): pubblica, senza sessione.
 * Aprirla NON conferma: gli scanner della posta («safe links») aprono i link
 * ed eseguono il JS, e il cambio avverrebbe senza che una persona abbia
 * cliccato. Si legge il link, si mostra la nuova email, e si conferma SOLO
 * col bottone. Un link sbagliato, scaduto, usato o annullato dice una frase
 * sola, senza nomi; un indirizzo preso nel frattempo lo dice, e l'email resta
 * com'era.
 */
export function EmailChangePage({ token }: { token: string }) {
  const { t } = useTranslation();
  const link = useEmailChangeLink(token);
  const confirm = useConfirmEmailChange();
  const result = confirm.data;
  const reason = result && !result.ok && "reason" in result ? result.reason : null;
  const goToSignIn = (
    <Link to="/login" className={`${textButton} text-sm`}>
      {t("entry.register.goToSignIn")}
    </Link>
  );

  let body;
  if (link.isPending) {
    body = (
      <div aria-busy="true" aria-label={t("entry.emailChange.confirming")} className="mb-6">
        <div className="h-8 w-56 animate-pulse rounded-md bg-ink/8 motion-reduce:animate-none" />
      </div>
    );
  } else if (link.isError) {
    body = (
      <>
        <EntryHeading title={t("entry.emailChange.confirmTitle")} />
        <ErrorLine
          action={
            <button
              type="button"
              className={`${textButton} ml-1`}
              onClick={() => void link.refetch()}
            >
              {t("taskUi.states.retry")}
            </button>
          }
        >
          {t("entry.emailChange.failed")}
        </ErrorLine>
      </>
    );
  } else if (result?.ok) {
    body = (
      <section>
        <EntryHeading
          title={t("entry.emailChange.title")}
          lead={t("entry.emailChange.done", { email: result.email })}
        />
        {goToSignIn}
      </section>
    );
  } else if (reason === "email_taken") {
    body = (
      <section>
        <EntryHeading
          title={t("entry.emailChange.takenTitle")}
          lead={t("entry.emailChange.takenBody")}
        />
        {goToSignIn}
      </section>
    );
  } else if (result || link.data.status === "invalid") {
    // Un rifiuto della conferma (il link è scaduto fra la lettura e il clic) dice lo stesso.
    body = (
      <section>
        <EntryHeading
          title={t("entry.emailChange.invalidTitle")}
          lead={t("entry.emailChange.invalidBody")}
        />
        {goToSignIn}
      </section>
    );
  } else {
    body = (
      <section className="flex flex-col items-start gap-4">
        <EntryHeading
          title={t("entry.emailChange.confirmTitle")}
          lead={t("entry.emailChange.confirmBody", { email: link.data.email })}
        />
        <button
          type="button"
          className={primaryButton}
          aria-busy={confirm.isPending || undefined}
          onClick={() => {
            if (!confirm.isPending) confirm.mutate(token);
          }}
        >
          <BusyLabel
            busy={confirm.isPending}
            idle={t("entry.emailChange.confirm")}
            pending={t("entry.emailChange.confirmingButton")}
          />
        </button>
        {confirm.isError && <ErrorLine>{t("entry.emailChange.failed")}</ErrorLine>}
      </section>
    );
  }

  return <EntryColumn>{body}</EntryColumn>;
}
