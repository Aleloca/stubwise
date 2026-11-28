import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";

// I pezzi della pagina a sé della cassaforte (I-2): gli stessi segni
// dell'ingresso dell'app (`pages/entry/parts.tsx`, `pages/tasks/controls.tsx`),
// riscritti qui perché quei moduli tirano dentro il livello dati dell'app.

export const primaryButton =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-ink px-3 text-sm font-semibold text-ground transition-opacity duration-[var(--duration-fast)] ease-out hover:opacity-90 active:opacity-80 disabled:opacity-40";
export const secondaryButton =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-rule-strong px-3 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10 disabled:opacity-40";
export const inputClass =
  "w-full rounded-md border border-rule-strong bg-ground px-3 text-md text-ink outline-none focus-visible:border-ink";

/** Il monogramma «S_» dell'app. */
function Logo() {
  const { t } = useTranslation();
  return (
    <span
      role="img"
      aria-label={t("rail.logo")}
      className="grid size-8 place-items-center rounded-lg bg-[#0f1318] font-logo text-[13px] font-semibold tracking-[-0.02em] text-[#f5a623] shadow-[inset_0_0_0_1px_var(--rule-strong)] select-none"
    >
      S_
    </span>
  );
}

/** La colonna da 432 px dell'ingresso. */
export function Column({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col bg-ground text-ink">
      <main className="mx-auto flex w-full max-w-[432px] flex-col px-4 pt-[max(28px,calc(33vh-196px))] pb-12">
        <div className="mb-6">
          <Logo />
        </div>
        {children}
      </main>
    </div>
  );
}

export function Heading({ title, lead }: { title: string; lead?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-[-0.01em] text-balance text-ink">{title}</h1>
      {lead && <p className="text-md text-pretty text-ink-muted">{lead}</p>}
    </header>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-sm text-ink">
      <span aria-hidden="true" className="text-critical">
        ⊗
      </span>
      <span className="min-w-0">{children}</span>
    </p>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <p role="status" className="text-md text-positive">{children}</p>;
}

export function BusyLabel({ busy, idle, pending }: { busy: boolean; idle: ReactNode; pending: ReactNode }) {
  return (
    <span className="inline-grid justify-items-center">
      <span className={`col-start-1 row-start-1 ${busy ? "invisible" : ""}`}>{idle}</span>
      <span aria-hidden={!busy} className={`col-start-1 row-start-1 ${busy ? "" : "invisible"}`}>
        {pending}
      </span>
    </span>
  );
}

/** Il codice a 6 cifre dell'app di autenticazione. */
export function CodeInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        autoFocus
        className={`${inputClass} num h-9 w-40 text-lg tracking-[0.2em]`}
      />
    </label>
  );
}

export function formatDateTime(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(iso),
  );
}

/** Il codice di un esito nella frase da mostrare; un codice ignoto è «qualcosa non è andato». */
export function errorKey(code: string): string {
  const known = [
    "unauthenticated",
    "passkey_failed",
    "passkey_unsupported",
    "no_seal",
    "no_passkeys",
    "passkey_unknown",
    "open_failed",
    "stale_key",
    "no_prf",
    "session",
    "vault_already_active",
    "has_key",
    "already_sealed",
    "fingerprint_mismatch",
    "pairing_invalid",
    "no_pairing",
    "nothing_opened",
    "not_pending",
    "worker_unavailable",
    "network",
    "forbidden",
    "code_required",
    "presence_required",
    "invalid_second_factor",
    "locked",
    "credential_mismatch",
  ];
  return `vault.setup.errors.${known.includes(code) ? code : "failed"}`;
}
