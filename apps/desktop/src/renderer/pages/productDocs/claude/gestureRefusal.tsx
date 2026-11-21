import { Trans, useTranslation } from "react-i18next";
import { usePersonName, useProductSpaceContext } from "../parts";

// Revisione di R11-5, 3: un rifiuto di «Undo» o «Looks good» (il server, o il
// livello finto con `refused: <motivo>`, ha deciso) è definitivo: si dice il
// motivo e non c'è «Retry». «Retry» resta per un errore di rete.

export type GestureRefusal = {
  kind: "changed_after" | "already_undone" | "section_busy" | "forbidden" | "not_found";
  byId: string | null;
};

const KINDS = [
  "changed_after",
  "already_undone",
  "section_busy",
  "forbidden",
  "not_found",
  "no_permission",
] as const;

/** Il rifiuto di un gesto, o `null` se l'errore va riprovato (rete, server giù). */
export function refusalOf(error: unknown): GestureRefusal | null {
  if (!(error instanceof Error)) return null;
  const reason = error.message.replace(/^refused: /, "");
  if (!(KINDS as readonly string[]).includes(reason)) return null;
  const byId = (error as Error & { byId?: unknown }).byId;
  return {
    kind: reason === "no_permission" ? "forbidden" : (reason as GestureRefusal["kind"]),
    byId: typeof byId === "string" ? byId : null,
  };
}

/** La frase di un rifiuto, col nome di chi quando lo si sa. */
export function RefusalText({ refusal }: { refusal: GestureRefusal }) {
  const { t } = useTranslation();
  const nameOf = usePersonName();
  const { project } = useProductSpaceContext();
  const name = refusal.byId ? nameOf(refusal.byId) : null;
  const b = <strong className="font-semibold text-ink" />;
  const text = (() => {
    switch (refusal.kind) {
      case "changed_after":
        return name ? (
          <Trans i18nKey="productDocs.mark.changedAfter" values={{ name }} components={{ b }} />
        ) : (
          t("productDocs.mark.changedAfterNobody")
        );
      case "already_undone":
        return name
          ? t("productDocs.mark.alreadyUndone", { name })
          : t("productDocs.mark.alreadyUndoneNobody");
      case "section_busy":
        return name ? (
          <Trans i18nKey="productDocs.mark.sectionBusy" values={{ name }} components={{ b }} />
        ) : (
          t("productDocs.mark.sectionBusyNobody")
        );
      case "forbidden":
        return t("productDocs.mark.readOnly", { code: project.code });
      case "not_found":
        return t("productDocs.mark.gone");
    }
  })();
  return (
    <p role="status" data-gesture-refusal="" className="text-xs leading-4 text-ink-muted">
      {text}
    </p>
  );
}
