import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useCreateRequest } from "../../../data/queries";
import type { ProductDocOrigin } from "../../../data/types";
import { useToast } from "../../../tasks-ui/Toast";
import { secondaryButton } from "../../tasks/controls";

// «Open a request» da una domanda di Claude nella build app (area 11, F5;
// decisione del maintainer, strada 1): la scheda B sta nel filo, sotto la
// domanda, non nel riquadro (che nell'app è la conversazione del Claude del
// server). Titolo e descrizione da `question.request`, come
// `productQuestionRequestDraft` del prototipo; «Create request» la crea con
// l'origine della domanda (il server chiude la domanda nella stessa
// transazione), «Cancel» la chiude e la domanda resta aperta. Il prototipo
// resta col riquadro (tabella di parità).

export function RequestCard({
  projectId,
  projectCode,
  request,
  origin,
  onDone,
  onCancel,
  onAlreadyAnswered,
}: {
  projectId: string;
  projectCode: string;
  request: { title: string; description: string };
  origin: Required<ProductDocOrigin>;
  onDone: () => void;
  onCancel: () => void;
  onAlreadyAnswered: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const create = useCreateRequest();
  const card = useRef<HTMLDivElement>(null);
  // Aperta, il fuoco va alla scheda (come la scheda B nel riquadro).
  useEffect(() => card.current?.focus(), []);

  const confirm = () =>
    create
      .mutateAsync({
        input: { projectId, title: request.title, description: request.description, origin },
      })
      .then(onDone, (error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        if (message === "already_answered") onAlreadyAnswered();
        else toast.error(t("productDocs.question.requestCard.failed"));
      });

  return (
    <div
      ref={card}
      tabIndex={-1}
      data-request-card=""
      role="group"
      aria-label={t("productDocs.question.requestCard.label", { code: projectCode })}
      className="flex flex-col gap-1.5 rounded-md border border-rule bg-ground p-2.5 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      <p className="text-xs leading-4 text-ink-muted">
        {t("productDocs.question.requestCard.label", { code: projectCode })}
      </p>
      <p className="text-sm font-semibold text-ink [overflow-wrap:anywhere]">{request.title}</p>
      {request.description.trim() !== "" && (
        <p className="line-clamp-4 text-sm leading-5 whitespace-pre-line text-ink-muted [overflow-wrap:anywhere]">
          {request.description}
        </p>
      )}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          disabled={create.isPending}
          onClick={() => void confirm()}
          className="inline-flex h-7 items-center rounded-md bg-ink px-2.5 text-sm font-medium text-ground disabled:opacity-60"
        >
          {t("productDocs.question.requestCard.create")}
        </button>
        <button
          type="button"
          disabled={create.isPending}
          onClick={onCancel}
          className={secondaryButton}
        >
          {t("productDocs.question.requestCard.cancel")}
        </button>
      </div>
    </div>
  );
}
