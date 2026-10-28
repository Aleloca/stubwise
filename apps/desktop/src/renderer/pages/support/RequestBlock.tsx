import { Link } from "@tanstack/react-router";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOpenRequestFrom, type SupportConversationView } from "../../data/queries";
import { Dialog, DialogField, inputClass } from "../../tasks-ui/Dialog";
import { wishTitle } from "../../domain/support/state";
import { formatDateTime } from "../../notifications/time";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton, secondaryButton, WorkingRing } from "../claude/conversation/parts";
import { RequestStatusLabel } from "../requests/marks";

// Il blocco della richiesta in testa al dettaglio (shape support.md §3, §5):
// cosa vuole il cliente, come un'intestazione di scheda — il desiderio
// riscritto con il codice della richiesta e cosa vede il cliente. In triage
// lo dice l'anello di Claude; su una «non conclusa» chi ha `backlog.create`
// apre la richiesta a mano (mai da sola, mai da un'email) [A 5].

/** Oltre quante righe il desiderio si chiude con «Show all». */
const WISH_LINES = 6;

function OpenRequestDialog({
  conv,
  onClose,
  onCreated,
}: {
  conv: SupportConversationView;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const open = useOpenRequestFrom();
  const titleId = useId();
  const descId = useId();
  // Precompilati dal desiderio, se il triage l'aveva riscritto (shape §5).
  const [title, setTitle] = useState(conv.rewrittenWish ? wishTitle(conv.rewrittenWish) : "");
  const [description, setDescription] = useState(conv.rewrittenWish ?? "");
  const submit = () => {
    if (!title.trim() || open.isPending) return;
    open.mutate(
      { code: conv.code, title: title.trim(), description },
      {
        onSuccess: (view) => {
          onClose();
          onCreated();
          if (view.request)
            toast.show(t("support.openDialog.created", { code: view.request.code }));
        },
        onError: () => toast.error(t("support.openDialog.error")),
      },
    );
  };
  return (
    <Dialog
      title={t("support.openDialog.title")}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("support.openDialog.cancel")}
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={!title.trim() || open.isPending}
            title={title.trim() ? undefined : t("support.openDialog.titleRequired")}
            onClick={submit}
          >
            {t("support.openDialog.create")}
          </button>
        </>
      }
    >
      <p className="text-sm text-ink-muted">
        {t("support.openDialog.project")}:{" "}
        <span className="num font-semibold text-ink">{conv.projectCode}</span>
      </p>
      <DialogField label={t("support.openDialog.titleLabel")} htmlFor={titleId}>
        <input
          id={titleId}
          data-autofocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          className={inputClass}
        />
      </DialogField>
      <DialogField label={t("support.openDialog.description")} htmlFor={descId}>
        <textarea
          id={descId}
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={`${inputClass} resize-y`}
        />
      </DialogField>
      <p className="text-sm text-ink-muted">
        {t("support.openDialog.attached", { count: conv.messages.length })}
      </p>
    </Dialog>
  );
}

function Wish({ text }: { text: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 1 || text.split("\n").length > WISH_LINES);
  }, [text]);
  return (
    <div className="flex flex-col items-start gap-1">
      <p
        ref={ref}
        className={`max-w-[72ch] text-md whitespace-pre-wrap text-ink [overflow-wrap:anywhere] ${open ? "" : "line-clamp-6"}`}
      >
        {text}
      </p>
      {(long || open) && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="rounded-sm text-sm font-medium text-ink-muted underline decoration-ink/30 underline-offset-2 hover:text-ink"
        >
          {open ? t("support.request.showLess") : t("support.request.showAll")}
        </button>
      )}
    </div>
  );
}

export function RequestBlock({ conv }: { conv: SupportConversationView }) {
  const { t, i18n } = useTranslation();
  const [dialog, setDialog] = useState(false);
  const codeRef = useRef<HTMLAnchorElement>(null);
  const focusCode = useRef(false);
  const req = conv.request;
  // Dopo «Open the request» il fuoco va al codice della richiesta (shape §6),
  // appena il blocco si riempie.
  useLayoutEffect(() => {
    if (req && focusCode.current) {
      focusCode.current = false;
      codeRef.current?.focus();
    }
  }, [req]);
  const card = "flex flex-col gap-2 rounded-lg border border-rule-strong px-4 py-3";

  if (req) {
    return (
      <section aria-label={t("support.request.label")} data-request-block className={card}>
        {/* Una riga sola: si accorcia il titolo, lo stato non va a capo da solo. */}
        <div className="flex min-w-0 items-center gap-x-3">
          <span className="heading-group shrink-0">{t("support.request.label")}</span>
          <Link
            ref={codeRef}
            to="/p/$code/$section"
            params={{ code: conv.projectCode, section: "requests" }}
            search={{ request: req.id } as never}
            data-request-code
            className="flex min-w-0 items-baseline gap-2 rounded-sm text-md text-ink underline-offset-4 hover:underline"
          >
            <span className="num shrink-0 text-xs font-semibold tracking-[0.02em]">{req.code}</span>
            <span className="min-w-0 truncate">{req.title}</span>
          </Link>
          <span className="ml-auto shrink-0">
            <RequestStatusLabel status={req.status} />
          </span>
        </div>
        <Wish text={req.description || req.title} />
        <p className="text-xs text-ink-muted">
          {t("support.request.customerSees")}{" "}
          <span className="font-semibold text-ink">
            {t(`support.customerStatus.${req.customerStatus}`)}
          </span>
          {conv.confirmedAt && (
            <>
              {" · "}
              {t("support.request.confirmed", {
                date: formatDateTime(conv.confirmedAt, i18n.language),
              })}
            </>
          )}
        </p>
      </section>
    );
  }

  if (conv.state === "triage") {
    return (
      <section aria-label={t("support.request.label")} data-request-block className={card}>
        <p className="flex items-center gap-2 text-md text-ink-muted">
          <WorkingRing size={12} />
          {t("support.request.triage")}
        </p>
      </section>
    );
  }

  return (
    <section aria-label={t("support.request.label")} data-request-block className={card}>
      <p className="text-md text-ink">{t("support.request.left")}</p>
      {conv.canOpenRequest ? (
        <div>
          <button type="button" className={primaryButton} onClick={() => setDialog(true)}>
            {t("support.request.open")}
          </button>
        </div>
      ) : (
        <p className="text-sm text-ink-muted">{t("support.request.cannotOpen")}</p>
      )}
      {dialog && (
        <OpenRequestDialog
          conv={conv}
          onClose={() => setDialog(false)}
          onCreated={() => {
            focusCode.current = true;
          }}
        />
      )}
    </section>
  );
}
