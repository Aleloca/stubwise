import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * `data-src="URL"` → aggiunge `src="URL"` (STESSO url, già validato
 * http/https da `sanitizeEmailHtml` lato server prima di finire in
 * `data-src`): questo è l'UNICO modo in cui un'immagine remota può caricare,
 * ed è un gesto esplicito dell'utente ("mostra immagini"), mai automatico.
 * Sicuro anche se l'HTML restasse "vivo" più a lungo del previsto: non
 * introduce un tag o un attributo nuovo, copia soltanto un valore che il
 * server ha già accettato.
 */
function revealImages(html: string): string {
  return html.replace(/(<img\b[^>]*?)\sdata-src="([^"]*)"/g, (_match, prefix: string, url: string) => {
    return `${prefix} data-src="${url}" src="${url}"`;
  });
}

/** Documento minimo per l'`<iframe srcDoc>`: sfondo CHIARO deliberato, vedi il commento su {@link UntrustedHtmlFrame}. */
function wrapEmailDocument(bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><style>
    body { margin: 0; padding: 12px; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 14px; line-height: 1.5; color: #1a1a1a; background: #ffffff; word-wrap: break-word; }
    img { max-width: 100%; height: auto; }
    a { color: #1a56db; }
  </style></head><body>${bodyHtml}</body></html>`;
}

/**
 * **HTML DI UN ESTRANEO, reso in sicurezza.** Estratto da
 * `mail-reading-pane.tsx` il 15 set 2026 (§2): la DESCRIZIONE di un evento di
 * calendario è HTML non fidato esattamente come il corpo di un'email — la
 * scrive chiunque abbia creato l'invito — e il design chiede di riusare il
 * percorso che esiste, non di scriverne un terzo. Da qui passano entrambe.
 *
 * Il contratto col chiamante: `html` è GIÀ SANIFICATO lato server
 * (`sanitizeEmailHtml`, `@stubwise/google`). Questo componente è la SECONDA
 * difesa, indipendente dalla prima — non un sostituto: chi gli passasse HTML
 * grezzo starebbe usando metà del meccanismo.
 *
 * Il corpo HTML sanificato, in un `<iframe sandbox>` — SECONDA difesa
 * indipendente dalla sanificazione lato server (design §4): anche se questa
 * avesse un buco, il contenuto non ha un'origine da cui fare danni.
 *
 * `sandbox="allow-popups allow-popups-to-escape-sandbox"`: **mai**
 * `allow-scripts` né `allow-same-origin` (i due esplicitamente vietati dal
 * design) — ma senza NESSUN permesso un link cliccato dentro l'iframe non
 * naviga da nessuna parte (il sandbox di default blocca anche l'apertura di
 * popup), il che renderebbe inutile ogni link legittimo nell'email.
 * `allow-popups` lo riabilita; `allow-popups-to-escape-sandbox` fa sì che la
 * scheda aperta sia un browser NORMALE (senza eredita il sandbox, altrimenti
 * il sito di destinazione — che quasi certamente usa JS — non funzionerebbe
 * lì dentro). Nessuna delle due riguarda l'ESECUZIONE dentro QUESTO iframe:
 * il contenuto dell'email resta sempre senza script e senza origine propria.
 *
 * Sfondo CHIARO deliberato (non il tema scuro di Stubwise): il contenuto è
 * di un estraneo, autorato assumendo (quasi sempre) uno sfondo chiaro — un
 * testo nero senza `background` esplicito diventerebbe illeggibile su
 * inchiostro scuro. È la stessa logica di un lettore PDF o di un embed: il
 * documento resta nel SUO aspetto, dentro una cornice che è chiaramente
 * Stubwise (il bordo, il bottone "mostra immagini").
 */
export function UntrustedHtmlFrame({ html, title }: { html: string; title: string }) {
  const { t } = useTranslation();
  const [showImages, setShowImages] = useState(false);
  const hasHiddenImages = useMemo(() => /\sdata-src="/.test(html), [html]);
  const rendered = useMemo(() => (showImages ? revealImages(html) : html), [html, showImages]);
  const srcDoc = useMemo(() => wrapEmailDocument(rendered), [rendered]);

  return (
    <div>
      {hasHiddenImages && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-sm border border-line-strong bg-ink-900 px-3 py-2">
          <p className="font-mono text-[11px] text-fg-faint">{t("common:untrustedHtml.imagesBlockedNotice")}</p>
          {!showImages && (
            <button
              type="button"
              onClick={() => setShowImages(true)}
              className="inline-flex min-h-8 items-center rounded-sm border border-line-strong px-2 font-mono text-[11px] tracking-[0.1em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg"
            >
              {t("common:untrustedHtml.showImages")}
            </button>
          )}
        </div>
      )}
      <iframe
        title={title}
        srcDoc={srcDoc}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        className="h-[50vh] w-full rounded-sm border border-signal-dim/40 bg-white"
      />
    </div>
  );
}

