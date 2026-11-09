import { Fragment, useLayoutEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { shortcutLabel } from "../../platform/platform";
import { copyText, downloadText } from "../../tasks-ui/exportFile";
import { useToast } from "../../tasks-ui/Toast";
import { secondaryButton } from "../tasks/controls";
import { TriangleGlyph } from "./glyphs";
import { rowButton, useFlash } from "./parts";

// Il valore mostrato una volta (shape preferences-account.md, «SecretOnce»):
// token, comando di Claude Code, chiave TOTP, codici di backup; in 9b e 9c
// anche i link d'invito e di reset. Il valore vive SOLO nelle props: chi lo
// mostra lo tiene nel proprio stato e lo butta con «Done»; lasciata la
// sezione o la pagina, il componente si smonta e il valore non è più nel DOM.
// Niente storage, niente cache, nessuna conferma all'uscita [PR 2].
// In 9c un blocco può mostrare più valori nati insieme (la chiave
// d'ingestione col suo DSN e lo snippet): ognuno col suo nome e il suo «Copy».

/**
 * Il testo con un punto in cui andare a capo dopo ogni «/» e «@» (`<wbr>`):
 * un indirizzo o un DSN va a capo fra le sue parti, non dentro una parola
 * («stub|wise»). Il testo resta identico, così si copia anche a mano; un
 * pezzo più lungo della riga lo spezza `[overflow-wrap:anywhere]` di chi lo
 * mostra.
 */
export function WithBreaks({ text }: { text: string }) {
  const parts = text.split(/(?<=[/@])/);
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </>
  );
}

/**
 * `code` (9c): un blocco di codice di più righe (lo snippet `init()`), con gli
 * a capo e i rientri com'erano, che va a capo dove serve dentro il riquadro.
 */
export type SecretLayout = "text" | "command" | "codes" | "code";

/** Un valore in più nello stesso blocco (area 9c: il DSN e lo snippet accanto alla chiave). */
export interface SecretExtra {
  label: string;
  value: string;
  layout?: Exclude<SecretLayout, "codes">;
}

export function SecretOnce({
  title,
  value,
  layout = "text",
  label,
  more = [],
  download,
  onDone,
  children,
}: {
  /** Il titolo del blocco: prende il fuoco all'arrivo, così si legge la frase «shown only now». */
  title: string;
  value: string;
  /** `codes`: un codice per riga, su due colonne; `command`: va a capo dove serve. */
  layout?: SecretLayout;
  /** Il nome del valore, sopra di lui, quando il blocco ne mostra più d'uno («Key»). */
  label?: string;
  /** Altri valori nati insieme, ognuno col suo «Copy»: si vedono una volta come il primo. */
  more?: readonly SecretExtra[];
  /** Il nome del file per «Download» (i codici di backup). */
  download?: string;
  /** «Done»: chi mostra il valore lo dimentica. Senza, il blocco resta finché si resta nella pagina. */
  onDone?: () => void;
  /** Le righe sotto il valore («Use it as STUBWISE_TOKEN…»). */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [manual, setManual] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const warningId = useId();

  // All'arrivo il fuoco va al titolo (annunciato con la frase sotto).
  useLayoutEffect(() => {
    titleRef.current?.focus();
  }, []);

  return (
    <div data-testid="secret-once" className="flex min-w-0 flex-col gap-2">
      <h3
        ref={titleRef}
        tabIndex={-1}
        aria-describedby={warningId}
        className="rounded-sm text-md font-semibold text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {title}
      </h3>
      <p id={warningId} className="flex items-start gap-1.5 text-sm text-ink">
        <span className="mt-0.5 shrink-0 text-warning">
          <TriangleGlyph />
        </span>
        <span>{t("prefs.secret.warning")}</span>
      </p>
      <SecretValue value={value} layout={layout} label={label} onManual={setManual} />
      {more.map((m) => (
        <SecretValue
          key={m.label}
          value={m.value}
          layout={m.layout ?? "text"}
          label={m.label}
          onManual={setManual}
        />
      ))}
      {manual && (
        <p role="status" className="text-sm text-ink-muted">
          {t("prefs.secret.manual", { keys: shortcutLabel(["mod", "C"]) })}
        </p>
      )}
      {children && <div className="flex flex-col gap-1 text-sm text-ink-muted">{children}</div>}
      {(onDone || download) && (
        <div className="mt-1 flex flex-wrap gap-2">
          {download && (
            <button
              type="button"
              className={secondaryButton}
              onClick={() => downloadText(download, value, "text/plain")}
            >
              {t("prefs.secret.download")}
            </button>
          )}
          {onDone && (
            <button type="button" className={secondaryButton} onClick={onDone}>
              {t("prefs.secret.done")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Un valore del blocco, col suo «Copy» in alto a destra. Senza appunti il
 * valore si seleziona da solo, e il blocco dice come copiarlo.
 */
function SecretValue({
  value,
  layout,
  label,
  onManual,
}: {
  value: string;
  layout: SecretLayout;
  label?: string;
  onManual: (manual: boolean) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [copied, flashCopied] = useFlash();
  const valueRef = useRef<HTMLDivElement>(null);

  function selectValue() {
    const el = valueRef.current;
    const selection = window.getSelection();
    if (!el || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function copy() {
    try {
      await copyText(value);
      onManual(false);
      flashCopied();
      toast.show(t("prefs.secret.copied"));
    } catch {
      onManual(true);
      selectValue();
    }
  }

  const codes = layout === "codes" ? value.split("\n") : null;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {label && <span className="text-xs font-medium text-ink-muted">{label}</span>}
      <div className="relative rounded-md border border-rule bg-ink/4 py-2.5 pr-16 pl-3">
        <div
          ref={valueRef}
          data-secret-value
          className="font-code select-all text-ink [font-size:13px]"
        >
          {codes ? (
            <ul className="grid grid-cols-[repeat(2,max-content)] gap-x-12 gap-y-1">
              {codes.map((c) => (
                <li key={c} className="num">
                  {c}
                </li>
              ))}
            </ul>
          ) : layout === "command" ? (
            // Il comando va a capo solo agli spazi: mai dentro «--token» o il
            // token. Il testo resta identico, così si copia anche a mano.
            <p>
              {value.split("\n").map((line, l) => (
                <span key={l} className="block whitespace-pre-wrap">
                  {line.split(" ").map((word, w) => (
                    <Fragment key={w}>
                      {w > 0 && " "}
                      <span className="whitespace-nowrap">{word}</span>
                    </Fragment>
                  ))}
                </span>
              ))}
            </p>
          ) : layout === "code" ? (
            <pre className="font-code whitespace-pre-wrap [overflow-wrap:anywhere]">
              <WithBreaks text={value} />
            </pre>
          ) : (
            <p className="[overflow-wrap:anywhere]">
              <WithBreaks text={value} />
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={
            label
              ? copied
                ? t("prefs.secret.copied")
                : t("prefs.secret.copyNamed", { name: label })
              : undefined
          }
          className={`${rowButton} absolute top-1.5 right-1.5 text-ink`}
        >
          {copied ? t("prefs.secret.copied") : t("prefs.secret.copy")}
        </button>
      </div>
    </div>
  );
}
