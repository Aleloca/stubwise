import { useTranslation } from "react-i18next";
import type { ProductOrigin } from "../../../data/types";
import { CodeLink } from "../../../components/CodeLink";

// «From the doc: ACQ-D11 Phases» (11b, Task 12; shape
// product-claude-backlog.md §3.4, [PB 5]): la pagina di prodotto da cui è
// nata una richiesta, sulla richiesta e sulla task che ne è nata. Il legame è
// con la pagina, non con la frase (la frase sta nella descrizione). La
// derivano le letture (`productOrigin`, P38) solo per chi la pagina la vede:
// per gli altri la riga non c'è, nessun codice tenue (R-G5). A 1024 va a capo
// dopo «From the doc:».

export function ProductOriginLine({ origin, className = "" }: { origin: ProductOrigin; className?: string }) {
  const { t } = useTranslation();
  return (
    <p data-product-origin="" className={`flex flex-wrap items-baseline gap-x-1 text-[13px] text-ink-muted ${className}`}>
      <span>{t("productDocs.backlog.fromDoc")}</span>{" "}
      <CodeLink code={origin.code} withName title={origin.title} />
    </p>
  );
}
