import { Link, useNavigate } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDeleteCredential } from "../../data/queries";
import { itemClass } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { MoreGlyph } from "../preferences/glyphs";
import type { CredentialView } from "../../data/vault/types";
import { dangerSolidButton, MenuButton, quietButton } from "../tasks/controls";
import { usePasswordReveal } from "./usePasswordReveal";

// Le righe delle credenziali (shape `vault.md` §3): servizio, utente, la
// password in pallini e, aperta, «Show» e «Copy» (le regole stanno in
// `usePasswordReveal`). Il servizio apre il dettaglio (`?credential=<id>`).

const DOTS = "••••••••••";

type Reveal = ReturnType<typeof usePasswordReveal>;

/** La password (pallini o mostrata) con Show/Hide e Copy: nelle righe e nel dettaglio. */
export function PasswordField({ row, reveal }: { row: CredentialView; reveal: Reveal }) {
  const { t } = useTranslation();
  const password = reveal.shown[row.id];
  return (
    <>
      <span
        className="min-w-0 flex-1 truncate font-mono text-[15px] text-ink"
        aria-label={
          password ? t("vault.row.passwordOf", { name: row.service }) : t("vault.row.hidden")
        }
        data-password={password ? "shown" : "hidden"}
      >
        {password ?? DOTS}
      </span>
      {password && (
        <span className="sr-only" aria-live="polite">
          {t("vault.row.shownLive")}
        </span>
      )}
      <span className="flex shrink-0 items-center gap-1">
        {password ? (
          <button
            type="button"
            className={quietButton}
            aria-label={t("vault.row.hideAria", { name: row.service })}
            onClick={() => reveal.hide(row.id)}
          >
            {t("vault.row.hide")}
          </button>
        ) : (
          <button
            type="button"
            className={quietButton}
            disabled={!reveal.usable}
            aria-label={t("vault.row.showAria", { name: row.service })}
            // Review M2: a cassaforte chiusa il clic apre il Touch ID [VA 4].
            title={reveal.locked ? t("vault.row.openFirst") : undefined}
            onClick={() => void reveal.show(row.id)}
          >
            {t("vault.row.show")}
          </button>
        )}
        <button
          type="button"
          className={quietButton}
          disabled={!reveal.usable}
          aria-label={t("vault.row.copyAria", { name: row.service })}
          // Review M2: a cassaforte chiusa il clic apre il Touch ID [VA 4].
          title={reveal.locked ? t("vault.row.openFirst") : undefined}
          onClick={() => void reveal.copy(row.id)}
        >
          {t("vault.row.copy")}
        </button>
      </span>
    </>
  );
}

/** Al posto della password, per chi aspetta o gestisce senza leggerla. */
export function AccessWord({ access }: { access: CredentialView["access"] }) {
  const { t } = useTranslation();
  return (
    <span className="min-w-0 flex-1 text-md text-ink-muted" data-access={access}>
      {access === "waiting" ? t("vault.row.waiting") : t("vault.row.manages")}
    </span>
  );
}

export function CredentialRows({
  rows,
  projectCodeOf,
}: {
  rows: CredentialView[];
  /** Nella pagina Vault: il codice del progetto prima del servizio. */
  projectCodeOf?: (projectId: string) => string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const reveal = usePasswordReveal();
  const remove = useDeleteCredential();
  const [deleting, setDeleting] = useState<string | null>(null);
  const openDetail = (id: string, edit = false) =>
    void navigate({
      to: ".",
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        credential: id,
        edit: edit ? "1" : undefined,
      })) as never,
    });
  const onDelete = async (row: CredentialView) => {
    setDeleting(null);
    const out = await remove.mutateAsync(row.id).catch(() => null);
    if (out?.ok) toast.show(t("vault.rowMenu.deleted", { name: row.service }));
    else toast.error(t("vault.rowMenu.deleteFailed", { name: row.service }));
  };

  return (
    <ul className="border-t border-rule">
      {rows.map((row) => (
        <Fragment key={row.id}>
          <li
            data-credential={row.id}
            className="flex min-h-11 items-center gap-4 border-b border-rule px-3 py-1.5"
          >
            {projectCodeOf && (
              <Link
                to="/p/$code/$section"
                params={{ code: projectCodeOf(row.projectId), section: "credentials" }}
                className="num w-12 shrink-0 text-sm font-semibold text-ink-muted hover:text-ink hover:underline"
              >
                {projectCodeOf(row.projectId)}
              </Link>
            )}
            <span className="flex w-56 min-w-0 shrink-0 flex-col items-start">
              <button
                type="button"
                className="max-w-full truncate rounded-sm text-left text-md font-semibold text-ink hover:underline"
                onClick={() => openDetail(row.id)}
              >
                {row.service}
              </button>
              {row.label && <span className="truncate text-sm text-ink-muted">{row.label}</span>}
            </span>
            <span
              className="w-48 min-w-0 shrink-0 truncate text-md text-ink"
              title={row.username ?? undefined}
            >
              {row.username}
            </span>
            {row.access === "reads" ? (
              <PasswordField row={row} reveal={reveal} />
            ) : (
              <AccessWord access={row.access} />
            )}
            {/* Il «⋯» secondo i permessi del server: Edit · Readers · Access log · Delete…. */}
            <MenuButton
              label={<MoreGlyph />}
              ariaLabel={t("vault.rowMenu.more", { name: row.service })}
              menuLabel={t("vault.rowMenu.menu", { name: row.service })}
              className={quietButton}
              align="right"
            >
              {(close) => (
                <>
                  {row.canEdit && (
                    <button
                      type="button"
                      role="menuitem"
                      className={itemClass}
                      onClick={() => {
                        close();
                        openDetail(row.id, true);
                      }}
                    >
                      {t("vault.rowMenu.edit")}
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    className={itemClass}
                    onClick={() => {
                      close();
                      openDetail(row.id);
                    }}
                  >
                    {t("vault.rowMenu.readers")}
                  </button>
                  {(row.canEdit || row.canShare) && (
                    <button
                      type="button"
                      role="menuitem"
                      className={itemClass}
                      onClick={() => {
                        close();
                        openDetail(row.id);
                      }}
                    >
                      {t("vault.rowMenu.log")}
                    </button>
                  )}
                  {row.canEdit && (
                    <button
                      type="button"
                      role="menuitem"
                      className={itemClass}
                      onClick={() => {
                        close();
                        setDeleting(row.id);
                      }}
                    >
                      {t("vault.rowMenu.delete")}
                    </button>
                  )}
                </>
              )}
            </MenuButton>
          </li>
          {deleting === row.id && (
            <li className="flex flex-wrap items-center gap-3 border-b border-rule bg-ink/3 px-3 py-2 text-md">
              <span className="min-w-0 flex-1 text-ink">
                {t("vault.rowMenu.deleteQuestion", { name: row.service })}
              </span>
              <button
                type="button"
                className={dangerSolidButton}
                onClick={() => void onDelete(row)}
              >
                {t("vault.rowMenu.deleteYes", { name: row.service })}
              </button>
              <button type="button" className={quietButton} onClick={() => setDeleting(null)}>
                {t("vault.rowMenu.cancel")}
              </button>
            </li>
          )}
        </Fragment>
      ))}
    </ul>
  );
}
