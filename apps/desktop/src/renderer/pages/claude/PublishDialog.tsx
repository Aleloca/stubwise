import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSetVisibility } from "../../data/queries";
import type { ConversationDetail } from "../../data/types";
import { Dialog } from "../../tasks-ui/Dialog";
import { primaryButton, secondaryButton } from "../tasks/controls";

type Touched = { id: string; code: string; name: string };

/**
 * «Make this conversation public?» (480 px): chi la leggerà, l'elenco dei
 * progetti che Claude ha letto o toccato (codice + nome, senza distinguere
 * fra letti e toccati), cosa vede chi non ne vede uno, e la responsabilità
 * nel bottone — nessuna casella da spuntare.
 *
 * L'elenco lo dà il livello dati: la prima chiamata senza conferma risponde
 * `needs_confirmation` con i progetti di adesso; si conferma proprio
 * quell'elenco. Se nel frattempo Claude ne ha toccato un altro, la conferma
 * torna indietro con l'elenco nuovo e il dialogo resta aperto.
 *
 * `reconfirm`: la pubblica ha toccato un progetto nuovo e il seguito è
 * privato (R-E6). Il dialogo mostra solo i progetti nuovi; si conferma
 * l'elenco intero.
 */
export function PublishDialog({
  detail,
  reconfirm = false,
  onClose,
  onDone,
}: {
  detail: ConversationDetail;
  reconfirm?: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const setVisibility = useSetVisibility();
  const [touched, setTouched] = useState<Touched[] | null>(null);
  const [failed, setFailed] = useState(false);
  const listId = useId();
  const { mutate } = setVisibility;

  const load = () => {
    setFailed(false);
    mutate(
      { id: detail.id, visibility: "public" },
      {
        onSuccess: (result) => {
          if (result.status === "needs_confirmation") setTouched(result.touchedProjects);
          // Nulla da confermare (non succede: la prima chiamata chiede sempre).
          else onDone();
        },
        onError: () => setFailed(true),
      },
    );
  };
  useEffect(() => {
    load();
    // Una lettura sola all'apertura («Retry» la rifà).
  }, []);

  const confirm = () => {
    if (!touched) return;
    setFailed(false);
    setVisibility.mutate(
      { id: detail.id, visibility: "public", confirmedProjectIds: touched.map((p) => p.id) },
      {
        onSuccess: (result) => {
          if (result.status === "needs_confirmation") setTouched(result.touchedProjects);
          else onDone();
        },
        onError: () => setFailed(true),
      },
    );
  };

  const published = new Set(detail.publishedProjectIds);
  const shown = reconfirm ? (touched ?? []).filter((p) => !published.has(p.id)) : (touched ?? []);
  const heading = reconfirm
    ? t("claude.destination.publish.newProjects")
    : t("claude.destination.publish.projects");

  return (
    <Dialog
      title={t(
        reconfirm
          ? "claude.destination.publish.reconfirmTitle"
          : "claude.destination.publish.title",
      )}
      description={t(
        reconfirm ? "claude.destination.publish.reconfirmBody" : "claude.destination.publish.body",
      )}
      width={480}
      onClose={onClose}
      footer={
        <>
          <button type="button" data-autofocus className={secondaryButton} onClick={onClose}>
            {t("claude.destination.page.cancel")}
          </button>
          <button
            type="button"
            className={`${primaryButton} disabled:opacity-40`}
            disabled={touched === null || setVisibility.isPending}
            onClick={confirm}
          >
            {t(
              reconfirm
                ? "claude.destination.publish.reconfirmConfirm"
                : "claude.destination.publish.confirm",
            )}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <p id={listId} className="heading-group">
          {heading}
        </p>
        {touched === null ? (
          failed ? (
            <div role="alert" className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-critical">{t("claude.destination.publish.loadFailed")}</p>
              <button type="button" className={secondaryButton} onClick={load}>
                {t("claude.destination.publish.retry")}
              </button>
            </div>
          ) : (
            <p role="status" className="text-sm text-ink-muted">
              {t("claude.destination.publish.checking")}
            </p>
          )
        ) : shown.length === 0 ? (
          <p className="text-sm text-ink-muted">
            {t(
              reconfirm
                ? "claude.destination.publish.nothingNew"
                : "claude.destination.publish.none",
            )}
          </p>
        ) : (
          <ul aria-labelledby={listId} className="flex max-h-60 flex-col overflow-y-auto">
            {shown.map((p) => (
              <li
                key={p.id}
                className="flex h-9 min-w-0 items-center gap-3 border-b border-rule last:border-b-0"
              >
                <span className="num w-12 shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
                  {p.code}
                </span>
                <span className="min-w-0 truncate text-md text-ink">{p.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {touched !== null && shown.length > 0 && (
        <p className="text-sm text-ink-muted">{t("claude.destination.publish.note")}</p>
      )}
      {failed && touched !== null && (
        <p role="alert" className="text-sm text-critical">
          {t("claude.destination.page.publishFailed")}
        </p>
      )}
    </Dialog>
  );
}
