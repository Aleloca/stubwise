import { Link } from "@tanstack/react-router";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useCreateToken, useMyTokens, useRevokeToken, type TokenView } from "../../data/queries";
import { useReauth } from "../../layout/useReauth";
import { useToast } from "../../tasks-ui/Toast";
import { BusyLabel, EntryField } from "../entry/parts";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { TriangleGlyph } from "./glyphs";
import {
  ArmedButton,
  PrefsPage,
  ReadError,
  Reveal,
  RowsSkeleton,
  WriteError,
  refusalOf,
  useDateLabel,
  useDayWord,
} from "./parts";
import { SecretOnce } from "./SecretOnce";

// Preferenze → Tokens (shape preferences-account.md): «New token» apre in
// posto il modulo sopra l'elenco; creare chiede la riconferma e mostra il
// valore UNA volta (`SecretOnce`). L'elenco dice nome e date, mai il valore,
// nemmeno troncato. Revocare è una conferma a due tempi in posto.

/** Il collegamento a una sezione dentro una frase tradotta. */
export function SectionLink({
  section,
  children,
}: {
  section: "tokens" | "claude-code" | "security";
  children?: ReactNode;
}) {
  return (
    <Link
      to="/preferences/$section"
      params={{ section }}
      className="text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink"
    >
      {children}
    </Link>
  );
}

/** Le colonne dell'elenco; sotto i 680 px (finestra a 1024) «Last used» scende sotto il nome. */
const GRID =
  "grid grid-cols-[minmax(0,1fr)_80px_96px_96px] items-center gap-x-4 @[680px]:grid-cols-[minmax(0,1fr)_80px_96px_104px_96px]";
const WIDE_ONLY = "hidden @[680px]:block";

export function TokensSection() {
  const { t } = useTranslation();
  const tokens = useMyTokens();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);

  const open = () => {
    setCreated(null);
    setCreating(true);
  };
  const close = () => {
    setCreating(false);
    newButton.current?.focus();
  };

  let body;
  if (tokens.isError && !tokens.data) {
    body = (
      <ReadError message={t("prefs.tokens.loadError")} onRetry={() => void tokens.refetch()} />
    );
  } else if (tokens.isPending) {
    body = <RowsSkeleton parts={1} />;
  } else {
    body = (
      <div className="mt-6 border-t border-rule pt-5">
        {creating && (
          <Reveal>
            <NewTokenForm
              onCancel={close}
              onCreated={(value) => {
                setCreating(false);
                setCreated(value);
              }}
            />
          </Reveal>
        )}
        {created && (
          <div className="mb-6">
            <SecretOnce
              title={t("prefs.tokens.created", { name: created.name })}
              value={created.token}
              onDone={() => setCreated(null)}
            >
              <p>
                <Trans
                  i18nKey="prefs.tokens.use"
                  components={{ link: <SectionLink section="claude-code" /> }}
                />
              </p>
            </SecretOnce>
          </div>
        )}
        {tokens.data.length === 0 ? (
          !creating && <p className="py-2 text-md text-ink-muted">{t("prefs.tokens.empty")}</p>
        ) : (
          <TokenTable tokens={tokens.data} />
        )}
      </div>
    );
  }

  return (
    <PrefsPage
      title={t("prefs.sections.tokens")}
      intro={t("prefs.tokens.intro")}
      action={
        !creating && (
          <button ref={newButton} type="button" className={secondaryButton} onClick={open}>
            {t("prefs.tokens.new")}
          </button>
        )
      }
    >
      {body}
    </PrefsPage>
  );
}

function NewTokenForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (created: { name: string; token: string }) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const reauth = useReauth();
  const create = useCreateToken();
  const [name, setName] = useState("");
  const [expires, setExpires] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [expiresError, setExpiresError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setNameError(null);
    setExpiresError(null);
    setFailed(false);
    const trimmed = name.trim();
    if (!trimmed) return setNameError(t("prefs.tokens.nameEmpty"));
    // Fine giornata (UTC) del giorno scelto: «scade il 3 dic» vale tutto il 3.
    const expiresAt = expires ? `${expires}T23:59:59Z` : null;
    try {
      const r = await reauth(() => create.mutateAsync({ name: trimmed, expiresAt }), {
        action: t("prefs.reauth.createToken"),
      });
      const refusal = refusalOf(r);
      if (!refusal) {
        const ok = r as { token: string };
        return onCreated({ name: trimmed, token: ok.token });
      }
      if (refusal.error === "reauth_cancelled") return;
      if (refusal.reason === "expires_past" || refusal.reason === "expires")
        return setExpiresError(t("prefs.tokens.past"));
      if (refusal.reason === "name") return setNameError(t("prefs.tokens.nameEmpty"));
      setFailed(true);
    } catch {
      setFailed(true);
      toast.error(t("prefs.tokens.createFailed"));
    }
  }

  return (
    <form
      noValidate
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className="mb-6 flex flex-col gap-3 border-b border-rule pb-6"
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
        <EntryField
          label={t("prefs.tokens.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("prefs.tokens.namePlaceholder")}
          error={nameError}
          autoFocus
          maxLength={100}
        />
        <EntryField
          label={t("prefs.tokens.expires")}
          type="date"
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
          error={expiresError}
          hint={t("prefs.tokens.expiresHint")}
        />
      </div>
      {failed && (
        <WriteError message={t("prefs.tokens.createFailed")} onRetry={() => void submit()} />
      )}
      <div className="flex gap-2">
        <button type="submit" className={primaryButton} aria-busy={create.isPending}>
          <BusyLabel
            busy={create.isPending}
            idle={t("prefs.tokens.create")}
            pending={t("prefs.tokens.creating")}
          />
        </button>
        <button type="button" className={secondaryButton} onClick={onCancel}>
          {t("prefs.tokens.cancel")}
        </button>
      </div>
    </form>
  );
}

function TokenTable({ tokens }: { tokens: TokenView[] }) {
  const { t } = useTranslation();
  const head = "text-xs font-medium text-ink-muted";
  return (
    <div className="@container" role="table" aria-label={t("prefs.sections.tokens")}>
      <div role="rowgroup" className="sticky top-0 z-10 bg-ground">
        <div role="row" className={`${GRID} h-8 border-b border-rule`}>
          <span role="columnheader" className={head}>
            {t("prefs.tokens.cols.name")}
          </span>
          <span role="columnheader" className={head}>
            {t("prefs.tokens.cols.created")}
          </span>
          <span role="columnheader" className={head}>
            {t("prefs.tokens.cols.expires")}
          </span>
          <span role="columnheader" className={`${head} ${WIDE_ONLY}`}>
            {t("prefs.tokens.cols.lastUsed")}
          </span>
          <span role="columnheader" className="sr-only">
            {t("prefs.tokens.revoke")}
          </span>
        </div>
      </div>
      <div role="rowgroup">
        {tokens.map((token) => (
          <TokenRow key={token.id} token={token} />
        ))}
      </div>
    </div>
  );
}

function TokenRow({ token }: { token: TokenView }) {
  const { t } = useTranslation();
  const toast = useToast();
  const date = useDateLabel();
  const day = useDayWord();
  const revoke = useRevokeToken();
  const [failed, setFailed] = useState(false);
  const lastUsed = token.lastUsedAt ? day(token.lastUsedAt) : t("prefs.tokens.never");

  const doRevoke = () => {
    setFailed(false);
    revoke.mutate(token.id, {
      onSuccess: (r) => {
        if (refusalOf(r)) return setFailed(true);
        toast.show(t("prefs.tokens.revoked", { name: token.name }));
      },
      onError: () => setFailed(true),
    });
  };

  return (
    <div className="border-b border-rule last:border-b-0">
      <div role="row" className={`${GRID} min-h-10 py-1.5`}>
        <span role="cell" className="flex min-w-0 flex-col">
          <span title={token.name} className="truncate text-md text-ink">
            {token.name}
          </span>
          {/* A 1024 l'ultimo uso scende qui, come seconda riga. */}
          <span className="text-xs text-ink-muted @[680px]:hidden">
            {token.lastUsedAt
              ? t("prefs.tokens.lastUsedLine", { when: lastUsed })
              : t("prefs.tokens.neverUsed")}
          </span>
        </span>
        <span role="cell" className="num text-sm text-ink-muted">
          {date(token.createdAt)}
        </span>
        <span role="cell" className="num text-sm text-ink-muted">
          {token.expired ? (
            <span className="inline-flex items-center gap-1 text-ink">
              <span className="text-warning">
                <TriangleGlyph size={12} />
              </span>
              {t("prefs.tokens.expired")}
            </span>
          ) : token.expiresAt ? (
            date(token.expiresAt)
          ) : (
            t("prefs.tokens.never")
          )}
        </span>
        <span role="cell" className={`num text-sm text-ink-muted ${WIDE_ONLY}`}>
          {lastUsed}
        </span>
        <span role="cell" className="flex justify-end">
          <ArmedButton
            label={t("prefs.tokens.revoke")}
            sureLabel={t("prefs.tokens.revokeSure")}
            ariaLabel={t("prefs.tokens.revokeFor", { name: token.name })}
            disabled={revoke.isPending}
            onConfirm={doRevoke}
          />
        </span>
      </div>
      {failed && (
        <div className="pb-2">
          <WriteError message={t("prefs.tokens.revokeFailed")} onRetry={doRevoke} />
        </div>
      )}
    </div>
  );
}
