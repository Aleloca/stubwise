import { useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { SecretInput } from "../../../components/SecretField";
import {
  GOOGLE_SETUP,
  useCreateGoogleApp,
  useDeleteGoogleApp,
  useReplaceGoogleSecret,
  useUpdateGoogleApp,
  type GoogleAppView,
  type InstanceResult,
} from "../../../data/queries";
import { useReauth, type ReauthCancelled } from "../../../layout/useReauth";
import { Dialog, inputClass } from "../../../tasks-ui/Dialog";
import { useToast } from "../../../tasks-ui/Toast";
import { ErrorLine } from "../../entry/parts";
import { refusalOf } from "../../preferences/parts";
import {
  dangerSolidButton,
  primaryButton,
  quietButton,
  secondaryButton,
} from "../../tasks/controls";
import { CrossGlyph, Disclosure, TextField, useRefusalWords } from "./parts";

// I dialoghi di Google Workspace (shape admin-integrations.md «Google
// Workspace»): aggiungere un'app, modificarla, sostituirne il client secret,
// eliminarla. Aggiungere, sostituire ed eliminare chiedono la riconferma
// (`useReauth`); il secret vive solo nello stato del dialogo (`SecretInput`)
// e poi resta «•••• 7d1e». I domini sono gettoni: le regole (forma, un
// dominio a una sola app, caselle collegate) le decide il livello dati, e
// il dialogo ne dice il rifiuto sotto il campo, col dominio in causa.

type Errors = Partial<Record<"name" | "domains" | "clientId" | "secret" | "form", string>>;

/** Le parole di un rifiuto `in_use`: chi ha una casella, le persone che non vedo contate (R-G5). */
export function usePeopleWords() {
  const { t } = useTranslation();
  return (names: readonly string[], hidden: number): string => {
    if (names.length === 0) return t("admin.google.people.onlyHidden", { count: hidden });
    if (hidden > 0)
      return t("admin.google.people.andMore", { names: names.join(", "), count: hidden });
    if (names.length === 1) return t("admin.google.people.one", { name: names[0] });
    return t("admin.google.people.all", {
      names: names.slice(0, -1).join(", "),
      last: names[names.length - 1],
    });
  };
}

/** Il footer comune: Annulla e il bottone dell'azione. */
function Footer({
  submit,
  onCancel,
  onSubmit,
  busy,
  danger = false,
}: {
  submit: string;
  onCancel: () => void;
  onSubmit: () => void;
  busy: boolean;
  danger?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <button type="button" className={secondaryButton} onClick={onCancel}>
        {t("admin.integrations.cancel")}
      </button>
      <button
        type="button"
        disabled={busy}
        className={`${danger ? dangerSolidButton : primaryButton} disabled:opacity-40`}
        onClick={onSubmit}
      >
        {submit}
      </button>
    </>
  );
}

/**
 * I domini come gettoni: Invio o virgola aggiungono quello scritto, ✕ lo
 * toglie, Backspace sul campo vuoto toglie l'ultimo. Nessun controllo di
 * forma qui: lo fa il livello dati.
 */
function DomainChips({
  domains,
  onChange,
  draft,
  onDraft,
  error,
}: {
  domains: string[];
  onChange: (next: string[]) => void;
  draft: string;
  onDraft: (value: string) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const add = (raw: string) => {
    const parts = raw
      .split(",")
      .map((d) => d.trim())
      .filter((d) => d && !domains.includes(d));
    if (parts.length > 0) onChange([...domains, ...parts]);
  };
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      add(draft);
      onDraft("");
    } else if (e.key === "Backspace" && draft === "" && domains.length > 0) {
      onChange(domains.slice(0, -1));
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {t("admin.google.dialog.domains")}
      </label>
      <div
        onClick={() => input.current?.focus()}
        className={`${inputClass} flex h-auto min-h-8 flex-wrap items-center gap-1.5 py-1`}
      >
        {domains.map((d) => (
          <span
            key={d}
            className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-ink/8 pr-0.5 pl-2 text-sm text-ink"
          >
            <span className="min-w-0 truncate">{d}</span>
            <button
              type="button"
              aria-label={t("admin.google.dialog.removeDomain", { domain: d })}
              onClick={(e) => {
                e.stopPropagation();
                onChange(domains.filter((x) => x !== d));
                input.current?.focus();
              }}
              className="grid size-5 place-items-center rounded-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/10 hover:text-ink"
            >
              <CrossGlyph size={10} />
            </button>
          </span>
        ))}
        <input
          ref={input}
          id={id}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder={domains.length === 0 ? "audin.it" : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error ${id}-hint` : `${id}-hint`}
          onKeyDown={onKeyDown}
          onChange={(e) => {
            const value = e.target.value;
            if (!value.includes(",")) return onDraft(value);
            // La virgola chiude il dominio: quello che segue resta da scrivere.
            const cut = value.lastIndexOf(",");
            add(value.slice(0, cut));
            onDraft(value.slice(cut + 1).trimStart());
          }}
          onBlur={() => {
            add(draft);
            onDraft("");
          }}
          className="h-6 min-w-24 flex-1 bg-transparent text-md text-ink outline-none placeholder:text-ink-faint"
        />
      </div>
      {error && <ErrorLine id={`${id}-error`}>{error}</ErrorLine>}
      <p id={`${id}-hint`} className="text-xs text-ink-muted">
        {t("admin.google.dialog.domainsHint")}
      </p>
    </div>
  );
}

/** Un valore da incollare nella Console, con «Copy». */
function CopyValue({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-ink-muted">{label}</span>
      <span className="flex min-w-0 items-start gap-2">
        <code className="num min-w-0 flex-1 text-sm break-all text-ink">{value}</code>
        <button
          type="button"
          className={`${quietButton} h-6 shrink-0 px-1.5 text-xs`}
          onClick={() => {
            void navigator.clipboard?.writeText(value).catch(() => undefined);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? t("admin.google.dialog.copied") : t("admin.google.dialog.copy")}
        </button>
      </span>
    </div>
  );
}

/** La sezione chiusa «How to set it up in Google Cloud» (parità col web). */
function SetupGuide() {
  const { t } = useTranslation();
  return (
    <Disclosure title={t("admin.google.dialog.setupTitle")}>
      <CopyValue label={t("admin.google.dialog.redirectUri")} value={GOOGLE_SETUP.redirectUri} />
      <CopyValue label={t("admin.google.dialog.scopes")} value={GOOGLE_SETUP.scopes.join(" ")} />
      <p className="text-sm text-pretty text-ink-muted">{t("admin.google.dialog.internalHint")}</p>
      <p className="text-sm text-pretty text-ink-muted">{t("admin.google.dialog.apisHint")}</p>
    </Disclosure>
  );
}

/**
 * Le parole di un rifiuto di un'app (create o edit), al campo giusto.
 * `apps` serve solo a dire a quale app appartiene già un dominio.
 */
function useAppErrors(apps: readonly GoogleAppView[]) {
  const { t } = useTranslation();
  const refusalWords = useRefusalWords();
  const peopleWords = usePeopleWords();
  const words = (key: string, params?: Record<string, string>) =>
    t(`admin.google.dialog.errors.${key}`, params);
  return (
    result: InstanceResult<object> | ReauthCancelled | null,
    name: string,
  ): Errors | null => {
    if (result === null) return { form: t("admin.integrations.saveFailed") };
    if (!result.ok && result.error === "in_use")
      return {
        domains: words("inUse", {
          people: peopleWords(
            result.usedBy.map((u) => u.label),
            result.hiddenCount,
          ),
          own: t("admin.google.disconnectOwn"),
        }),
      };
    if (!result.ok && result.error === "invalid") {
      const bad = "name" in result ? result.name : "";
      switch (result.reason) {
        case "name":
          return { name: words("name") };
        case "domains":
          return { domains: words("domains") };
        case "domain":
          return { domains: words("domain", { name: bad }) };
        case "domain_taken":
          return {
            domains: words("domain_taken", {
              name: bad,
              app: apps.find((a) => a.domains.includes(bad))?.name ?? "",
            }),
          };
        case "client_id":
          return { clientId: words("client_id") };
        case "client_secret":
          return { secret: words("client_secret") };
      }
    }
    const refusal = refusalOf(result);
    if (!refusal) return null;
    if (refusal.error === "conflict") return { name: words("taken", { name }) };
    const form = refusalWords(refusal.error);
    return form ? { form } : {};
  };
}

/**
 * «Add an app» (560 px, +R): nome, domini, client ID, client secret e la
 * guida di Google Cloud. Dopo, il toast dice dove le persone la collegano.
 */
export function AddGoogleAppDialog({
  apps,
  onClose,
  onCreated,
}: {
  apps: readonly GoogleAppView[];
  onClose: () => void;
  onCreated: (appId: string) => void;
}) {
  const { t } = useTranslation();
  const create = useCreateGoogleApp();
  const reauth = useReauth();
  const toast = useToast();
  const errorsOf = useAppErrors(apps);
  const [name, setName] = useState("");
  const [domains, setDomains] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  async function submit() {
    // Quello scritto e non ancora diventato un gettone conta.
    const all = draft.trim() ? [...domains, draft.trim()] : domains;
    if (draft.trim()) {
      setDomains(all);
      setDraft("");
    }
    const missing: Errors = {
      ...(name.trim() ? {} : { name: t("admin.google.dialog.errors.name") }),
      ...(all.length > 0 ? {} : { domains: t("admin.google.dialog.errors.domains") }),
      ...(clientId.trim() ? {} : { clientId: t("admin.google.dialog.errors.client_id") }),
      ...(secret.trim() ? {} : { secret: t("admin.google.dialog.errors.client_secret") }),
    };
    setErrors(missing);
    if (Object.keys(missing).length > 0) return;
    setBusy(true);
    const trimmed = name.trim();
    const result = await reauth(
      () => create.mutateAsync({ name: trimmed, domains: all, clientId, clientSecret: secret }),
      { action: t("admin.google.dialog.addAction", { name: trimmed }) },
    ).catch(() => null);
    setBusy(false);
    const refused = errorsOf(result, trimmed);
    if (refused) return setErrors(refused);
    toast.show(
      t("admin.google.dialog.added", { name: trimmed, domain: all[0]!.toLowerCase() }),
    );
    onCreated((result as { appId: string }).appId);
    onClose();
  }

  return (
    <Dialog
      title={t("admin.google.dialog.addTitle")}
      onClose={onClose}
      width={560}
      footer={
        <Footer
          submit={t("admin.google.dialog.submitAdd")}
          onCancel={onClose}
          onSubmit={() => void submit()}
          busy={busy}
        />
      }
    >
      <TextField
        label={t("admin.google.dialog.name")}
        value={name}
        onChange={setName}
        placeholder={t("admin.google.dialog.namePlaceholder")}
        error={errors.name}
        autoFocus
      />
      <DomainChips
        domains={domains}
        onChange={setDomains}
        draft={draft}
        onDraft={setDraft}
        error={errors.domains}
      />
      <TextField
        label={t("admin.google.dialog.clientId")}
        value={clientId}
        onChange={setClientId}
        placeholder="123456.apps.googleusercontent.com"
        error={errors.clientId}
      />
      <SecretInput
        label={t("admin.google.dialog.clientSecret")}
        value={secret}
        onChange={setSecret}
        error={errors.secret}
      />
      <SetupGuide />
      {errors.form && <ErrorLine>{errors.form}</ErrorLine>}
    </Dialog>
  );
}

/** «Edit…» (560 px): nome, domini, client ID; nessuna riconferma. */
export function EditGoogleAppDialog({
  app,
  apps,
  onClose,
}: {
  app: GoogleAppView;
  apps: readonly GoogleAppView[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const update = useUpdateGoogleApp();
  const toast = useToast();
  const errorsOf = useAppErrors(apps);
  const [name, setName] = useState(app.name);
  const [domains, setDomains] = useState<string[]>(app.domains);
  const [draft, setDraft] = useState("");
  const [clientId, setClientId] = useState(app.clientId);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  async function submit() {
    const all = draft.trim() ? [...domains, draft.trim()] : domains;
    if (draft.trim()) {
      setDomains(all);
      setDraft("");
    }
    setErrors({});
    setBusy(true);
    const result = await update
      .mutateAsync([app.id, { name, domains: all, clientId }])
      .catch(() => null);
    setBusy(false);
    const refused = errorsOf(result, name.trim());
    if (refused) return setErrors(refused);
    toast.show(t("admin.integrations.saved"));
    onClose();
  }

  return (
    <Dialog
      title={t("admin.google.dialog.editTitle", { name: app.name })}
      onClose={onClose}
      width={560}
      footer={
        <Footer
          submit={t("admin.google.dialog.submitEdit")}
          onCancel={onClose}
          onSubmit={() => void submit()}
          busy={busy}
        />
      }
    >
      <TextField
        label={t("admin.google.dialog.name")}
        value={name}
        onChange={setName}
        error={errors.name}
        autoFocus
      />
      <DomainChips
        domains={domains}
        onChange={setDomains}
        draft={draft}
        onDraft={setDraft}
        error={errors.domains}
      />
      <TextField
        label={t("admin.google.dialog.clientId")}
        value={clientId}
        onChange={setClientId}
        error={errors.clientId}
      />
      {errors.form && <ErrorLine>{errors.form}</ErrorLine>}
    </Dialog>
  );
}

/** «Replace secret…» (440 px, +R). */
export function ReplaceGoogleSecretDialog({
  app,
  onClose,
}: {
  app: GoogleAppView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const replace = useReplaceGoogleSecret();
  const reauth = useReauth();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!value.trim()) return setError(t("admin.google.dialog.errors.client_secret"));
    setBusy(true);
    const result = await reauth(() => replace.mutateAsync([app.id, value]), {
      action: t("admin.google.replaceDialog.action", { name: app.name }),
    }).catch(() => null);
    setBusy(false);
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal) return setError(refusalWords(refusal.error) || null);
    toast.show(t("admin.google.replaceDialog.done", { name: app.name }));
    onClose();
  }

  return (
    <Dialog
      title={t("admin.google.replaceDialog.title", { name: app.name })}
      onClose={onClose}
      width={440}
      footer={
        <Footer
          submit={t("admin.google.replaceDialog.submit")}
          onCancel={onClose}
          onSubmit={() => void submit()}
          busy={busy}
        />
      }
    >
      <SecretInput
        label={t("admin.google.dialog.clientSecret")}
        value={value}
        onChange={setValue}
        error={error}
        autoFocus
      />
      <p className="text-sm text-ink-muted">{t("admin.google.replaceDialog.body")}</p>
    </Dialog>
  );
}

type InUse = { people: string[]; hidden: number };

/**
 * «Delete…»: con caselle collegate (dalla lettura, o dal rifiuto `in_use`
 * se nel frattempo qualcuno ne ha collegata una) il dialogo dice di chi
 * sono e come si scollegano, e si chiude e basta; senza, la conferma e la
 * riconferma.
 */
export function DeleteGoogleAppDialog({
  app,
  onClose,
}: {
  app: GoogleAppView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const remove = useDeleteGoogleApp();
  const reauth = useReauth();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const peopleWords = usePeopleWords();
  const [inUse, setInUse] = useState<InUse | null>(
    app.mailboxCount > 0 ? { people: app.mailboxPeople, hidden: app.hiddenMailboxCount } : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    const result = await reauth(() => remove.mutateAsync(app.id), {
      action: t("admin.google.deleteDialog.action", { name: app.name }),
    }).catch(() => null);
    setBusy(false);
    if (result !== null && !result.ok && result.error === "in_use")
      return setInUse({ people: result.usedBy.map((u) => u.label), hidden: result.hiddenCount });
    const refusal = result === null ? { error: "failed" } : refusalOf(result);
    if (refusal) return setError(refusalWords(refusal.error) || null);
    toast.show(t("admin.google.deleteDialog.done", { name: app.name }));
    onClose();
  }

  if (inUse)
    return (
      <Dialog
        title={t("admin.google.deleteDialog.inUseTitle", {
          name: app.name,
          count: inUse.people.length + inUse.hidden,
        })}
        onClose={onClose}
        width={480}
        footer={
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("admin.integrations.close")}
          </button>
        }
      >
        <p className="text-md text-pretty text-ink">{peopleWords(inUse.people, inUse.hidden)}</p>
        <p className="text-md text-pretty text-ink">{t("admin.google.disconnectOwn")}</p>
      </Dialog>
    );

  return (
    <Dialog
      title={t("admin.google.deleteDialog.title", { name: app.name })}
      onClose={onClose}
      width={440}
      footer={
        <Footer
          submit={t("admin.google.deleteDialog.submit")}
          onCancel={onClose}
          onSubmit={() => void submit()}
          busy={busy}
          danger
        />
      }
    >
      <p className="text-md text-pretty text-ink">{t("admin.google.deleteDialog.body")}</p>
      {error && <ErrorLine>{error}</ErrorLine>}
    </Dialog>
  );
}
