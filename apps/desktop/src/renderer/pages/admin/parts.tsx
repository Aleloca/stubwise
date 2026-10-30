import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AdminRefusal, SourceView } from "../../data/queries";
import { formatDate } from "../../notifications/time";

// I pezzi comuni dell'Amministrazione (shape admin-people.md): i permessi e
// i rifiuti in parole, l'avatar, il campione del reparto. La pagina è quella
// delle Preferenze (`PrefsPage`, `Part`): h1 28 px, riga in prosa, parti
// separate da filetti, nessuna card.

/** Quanti permessi mancanti si nominano prima di «and 2 more». */
const MISSING_SHOWN = 3;

/** Un permesso in parole («approve plans»), al suo posto il nome tecnico se manca la frase. */
export function usePermissionWords() {
  const { t } = useTranslation();
  return (permission: string) => t(`access.perm.${permission}`, { defaultValue: permission });
}

/** «view usage», «view usage and approve plans», «a, b, c and 2 more». */
export function useMissingWords() {
  const { t, i18n } = useTranslation();
  const words = usePermissionWords();
  return (missing: readonly string[]) => {
    const shown = missing.slice(0, MISSING_SHOWN).map(words);
    const rest = missing.length - shown.length;
    if (rest > 0) shown.push(t("admin.refusal.more", { count: rest }));
    return new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(shown);
  };
}

/** Un rifiuto in più rispetto a quelli del livello dati: chi agisce chiude la riconferma. */
export type UiRefusal = AdminRefusal | { ok: false; error: "reauth_cancelled" };

/**
 * Il rifiuto di una scrittura in parole, nel punto dell'azione (shape §5):
 * `name` è la persona su cui si agiva, `what` ciò che si dava (un ruolo).
 */
export function useRefusalWords() {
  const { t } = useTranslation();
  const missingWords = useMissingWords();
  return (r: UiRefusal, ctx: { name?: string; what?: string; self?: string } = {}): string => {
    switch (r.error) {
      case "escalation":
        return ctx.what
          ? t("admin.refusal.escalation", { what: ctx.what, missing: missingWords(r.missing) })
          : t("admin.refusal.escalationPlain", { missing: missingWords(r.missing) });
      case "reauth_cancelled":
        return t("admin.refusal.reauthCancelled");
      case "forbidden":
        return t("admin.refusal.forbidden");
      case "not_found":
        return t("admin.refusal.notFound");
      case "reauth_required":
        return t("admin.refusal.reauthCancelled");
      case "invalid":
        return reasonWords(t, r.reason, ctx);
    }
  };
}

type T = ReturnType<typeof useTranslation>["t"];

/** Il motivo di un `invalid`, o di un'azione spenta (`ActionBlock`), in parole. */
export function reasonWords(
  t: T,
  reason: string,
  ctx: { name?: string; self?: string } = {},
): string {
  switch (reason) {
    case "last_full_admin":
      return t("admin.refusal.lastFullAdmin", { name: ctx.name ?? "" });
    case "last_members_manager":
      return t("admin.refusal.lastMembersManager", { name: ctx.name ?? "" });
    case "self":
      return ctx.self ?? t("admin.refusal.self");
    case "forbidden":
      return t("admin.refusal.forbidden");
    case "no_second_factor":
      return t("admin.resetSecondFactor.noSecondFactor", { name: ctx.name ?? "" });
    case "identity_taken":
      return t("admin.refusal.identityTaken");
    case "identity":
      return t("admin.refusal.identity");
    case "email":
    case "email_taken":
    case "invite_exists":
      return t(`admin.invite.errors.${reason}`);
    default:
      return t("admin.refusal.status");
  }
}

/** La fonte di un permesso in più, in parole («given by Laura Costa on Oct 29»). */
export function useSourceWords() {
  const { t, i18n } = useTranslation();
  return (s: SourceView): string => {
    switch (s.kind) {
      case "grant":
        if (s.origin === "seed") return t("admin.person.projects.seed");
        return s.grantedByName
          ? t("admin.person.projects.given", {
              name: s.grantedByName,
              date: formatDate(s.at, i18n.language),
            })
          : t("admin.person.projects.givenNoName", { date: formatDate(s.at, i18n.language) });
      case "department":
        return t("admin.person.projects.department", { name: s.departmentName });
      case "role":
        return t("admin.person.projects.role", { name: s.roleName });
      case "full_admin":
        return t("admin.person.projects.fullAdmin");
    }
  };
}

/**
 * L'avatar di una persona in Amministrazione: le iniziali su inchiostro al
 * 10% (nessun colore proprio), 28 px nella riga e 56 px in testa alla
 * pagina. Un invito non ha ancora una persona: il disco vuoto tratteggiato.
 */
export function AdminAvatar({
  initials,
  size = 28,
  invite = false,
  muted = false,
}: {
  initials: string;
  size?: 28 | 56;
  invite?: boolean;
  muted?: boolean;
}) {
  const box = size === 56 ? "size-14 text-lg" : "size-7 text-xs";
  if (invite)
    return (
      <span
        aria-hidden="true"
        className={`${box} shrink-0 rounded-full border border-dashed border-rule-strong`}
      />
    );
  return (
    <span
      aria-hidden="true"
      className={`${box} grid shrink-0 place-items-center rounded-full font-semibold ${muted ? "bg-ink/6 text-ink-muted" : "bg-ink/10 text-ink"}`}
    >
      {initials}
    </span>
  );
}

/** Il campione di un reparto: la barra da 3 px della legenda (qui il colore è il contenuto). */
export function DeptSwatch({ colorToken, height = 16 }: { colorToken: string; height?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block w-[3px] shrink-0 rounded-[1px]"
      style={{ height, background: colorToken ? `var(${colorToken})` : "var(--ink-faint)" }}
    />
  );
}

/** Una riga in tono minore con il cerchio vuoto ○ (stato, motivo detto una volta). */
export function QuietLine({ children }: { children: ReactNode }) {
  return <p className="flex items-center gap-1.5 text-sm text-ink-muted">{children}</p>;
}

/** «Nov 5», nella lingua. */
export function useShortDate() {
  const { i18n } = useTranslation();
  return (iso: string) => formatDate(iso, i18n.language);
}
