import type { Language } from "@stubwise/shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { patchMyLanguage } from "../../lib/api";
import { meQueryOptions } from "../../lib/auth";

/**
 * Sotto-pagina Account: i dati dell'utente corrente (email, ruolo) e il
 * selettore di lingua. Visibile a tutti gli utenti autenticati. Il logout vive
 * nella sidebar del layout.
 */
export function SettingsAccountPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";

  // Cambio lingua: persiste la preferenza sul server, allinea subito la UI e
  // aggiorna la cache `me` così resta coerente con il valore appena salvato.
  const languageMutation = useMutation({
    mutationFn: (language: Language) => patchMyLanguage(language),
    onSuccess: async (_data, language) => {
      await i18n.changeLanguage(language);
      queryClient.setQueryData(meQueryOptions.queryKey, (prev) =>
        prev ? { ...prev, user: { ...prev.user, language } } : prev,
      );
    },
  });

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          {t("settings:account.title")}
        </h2>
      </header>
      <dl className="space-y-3 px-4 py-4">
        <div className="flex flex-col gap-1">
          <dt className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
            {t("settings:account.email")}
          </dt>
          <dd className="font-mono text-[13px] text-fg">{me.user.email}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
            {t("settings:account.role")}
          </dt>
          <dd>
            <span
              className={`inline-flex rounded-sm border px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] uppercase ${
                isAdmin ? "border-signal-dim/40 text-signal" : "border-line-strong text-fg-muted"
              }`}
            >
              {isAdmin ? t("settings:account.admin") : t("settings:account.member")}
            </span>
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor="account-language"
            className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase"
          >
            {t("settings:account.language")}
          </label>
          <select
            id="account-language"
            value={me.user.language}
            disabled={languageMutation.isPending}
            onChange={(event) => languageMutation.mutate(event.target.value as Language)}
            className="w-fit rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="en">{t("settings:account.languageEnglish")}</option>
            <option value="it">{t("settings:account.languageItalian")}</option>
          </select>
        </div>
      </dl>
    </section>
  );
}
