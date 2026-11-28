import { appPath, type VaultPage } from "@stubwise/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadMe, type Me } from "./api";
import { PairPage } from "./PairPage";
import { PasskeysPage } from "./PasskeysPage";
import { RecoverPage } from "./RecoverPage";
import { SetupPage } from "./SetupPage";
import { Column, ErrorLine, Heading, secondaryButton } from "./ui";

// La pagina A SÉ della cassaforte (revisione di sicurezza della fase 2, I-2;
// design §10): un documento suo (`vault.html`, `/vault/`), con la sua CSP
// stretta, e dentro solo il worker della cassaforte, il login che rimanda a
// quello dell'app, la riconferma e quattro pagine (attivare e la propria
// chiave, il recupero col kit, l'associazione di un Mac, le passkey della
// cassaforte). Ci si entra con una navigazione completa; fra le sue pagine
// si passa col frammento (`#/setup`, `#/recover`, `#/pair?state=…`,
// `#/passkeys`).

export interface Route {
  page: VaultPage;
  search: URLSearchParams;
}

export function parseRoute(hash: string): Route {
  const m = /^#\/(setup|recover|pair|passkeys)(?:\?(.*))?$/.exec(hash);
  return m ? { page: m[1] as VaultPage, search: new URLSearchParams(m[2] ?? "") } : { page: "setup", search: new URLSearchParams() };
}

/** Il login dell'app, che dopo l'accesso riporta qui (`next` in elenco chiuso). */
export function loginPath(route: Route): string {
  const state = route.page === "pair" ? route.search.get("state") : null;
  return appPath({ to: "login", search: { next: `vault-${route.page}`, ...(state ? { state } : {}) } });
}

export function VaultPageApp({ navigate = (url: string) => window.location.assign(url) }: { navigate?: (url: string) => void }) {
  const { t } = useTranslation();
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [me, setMe] = useState<Me | null | "loading" | "error">("loading");

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    let alive = true;
    loadMe().then(
      (m) => {
        if (!alive) return;
        // Senza una sessione completa: il login dell'app, con il ritorno qui.
        if (m === null) navigate(loginPath(parseRoute(window.location.hash)));
        setMe(m);
      },
      () => alive && setMe("error"),
    );
    return () => {
      alive = false;
    };
    // Una volta, al montaggio: `navigate` è stabile per chi monta la pagina.
  }, []);

  if (me === "loading" || me === null)
    return (
      <Column>
        <p aria-busy="true" className="text-md text-ink-muted">
          {t("vault.setup.page.loading")}
        </p>
      </Column>
    );
  if (me === "error")
    return (
      <Column>
        <Heading title={t("vault.setup.title")} />
        <ErrorLine>{t("vault.setup.errors.network")}</ErrorLine>
        <button type="button" className={`${secondaryButton} mt-3 self-start`} onClick={() => window.location.reload()}>
          {t("vault.setup.retry")}
        </button>
      </Column>
    );

  return (
    <Column>
      {route.page === "setup" && <SetupPage me={me} />}
      {route.page === "recover" && <RecoverPage me={me} />}
      {route.page === "passkeys" && <PasskeysPage />}
      {route.page === "pair" && <PairPage state={route.search.get("state") ?? ""} navigate={navigate} />}
      <nav aria-label={t("vault.setup.page.nav")} className="mt-10 flex flex-wrap gap-x-4 gap-y-2 border-t border-rule pt-4 text-sm">
        <a className="text-ink-muted underline hover:text-ink" href={appPath({ to: "vault" })}>
          {t("vault.setup.page.backToApp")}
        </a>
        {route.page !== "setup" && (
          <a className="text-ink-muted underline hover:text-ink" href="#/setup">
            {t("vault.setup.title")}
          </a>
        )}
        {route.page !== "passkeys" && (
          <a className="text-ink-muted underline hover:text-ink" href="#/passkeys">
            {t("vault.setup.page.passkeys")}
          </a>
        )}
        {me.fullAdmin && route.page !== "recover" && (
          <a className="text-ink-muted underline hover:text-ink" href="#/recover">
            {t("vault.setup.recovery.title")}
          </a>
        )}
      </nav>
    </Column>
  );
}
