import { useTranslation } from "react-i18next";
import { CodeLink } from "../../../components/CodeLink";
import type { ProductSourceView } from "../../../data/types";
import { DATED_SOURCE_LABELS } from "../../../domain/productDocs/claudeText";

// La fonte di una modifica di Claude, nelle sue forme (11b, Task 9; shape
// product-claude-mark.md §3.4, [PM 5]): UNA resa per il segno, la
// cronologia e la riga della prima versione. L'etichetta la compone il
// livello dati (`sourceViewOf`) per chi guarda, e qui si mostra così com'è:
// a chi non apre l'email arriva «From an email of Laura Costa · Nov 4»,
// senza oggetto né link, e nessun nodo (né `title`, né `aria-*`, né `data-*`)
// può dire di più, perché qui non c'è niente di più. Ha l'aspetto della riga
// «Used: …» di `ClaudeDraftMark` (12px, codici 600 tnum quieti, a capo,
// «+N» oltre due fonti), ma non comincia con «Used:»: la fonte è la causa
// della modifica, e l'etichetta comincia già con «From…» / «Da…».

/** Oltre queste fonti, «+N» col `title` delle altre. */
const SHOWN = 2;


function useSourceText() {
  const { t } = useTranslation();
  return (source: ProductSourceView) => t(source.label.key, source.label.params ?? {});
}

function OneSource({ source }: { source: ProductSourceView }) {
  const { t } = useTranslation();
  const label = useSourceText()(source);
  const dated = source.at && DATED_SOURCE_LABELS.has(source.label.key) ? t("productDocs.mark.date", { date: Date.parse(source.at) }) : null;
  return (
    <span data-source-kind={source.gone ? "gone" : source.kind}>
      {source.link ? (
        <a
          href={source.link}
          className="rounded-[3px] font-semibold text-ink underline decoration-transparent underline-offset-2 transition-colors duration-[var(--duration-fast)] ease-out hover:decoration-ink/60 focus-visible:decoration-ink/60"
        >
          {label}
        </a>
      ) : (
        <span>{label}</span>
      )}
      {dated && (
        <span className="num">
          <span aria-hidden="true"> · </span>
          {dated}
        </span>
      )}
      {source.code && (
        <>
          <span aria-hidden="true"> · </span>
          <CodeLink code={source.code} quiet />
        </>
      )}
    </span>
  );
}

/** La fonte (o le fonti, per la prima versione) di una modifica, 12px `ink-muted`. */
export function SourceLine({
  sources,
  className = "",
}: {
  sources: readonly ProductSourceView[];
  className?: string;
}) {
  const text = useSourceText();
  if (sources.length === 0) return null;
  const shown = sources.slice(0, SHOWN);
  const more = sources.slice(SHOWN);
  return (
    <p data-source-line="" className={`min-w-0 text-xs leading-4 text-ink-muted [overflow-wrap:anywhere] ${className}`}>
      {shown.map((s, i) => (
        <span key={i}>
          {i > 0 && <span aria-hidden="true"> · </span>}
          <OneSource source={s} />
        </span>
      ))}
      {more.length > 0 && (
        // Le etichette sono già quelle di chi guarda: il `title` non dice niente di più.
        <span className="num" title={more.map(text).join(" · ")}>
          {" "}
          +{more.length}
        </span>
      )}
    </p>
  );
}
