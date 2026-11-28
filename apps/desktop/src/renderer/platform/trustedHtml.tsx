import { sanitizeWireframeSvg } from "@stubwise/shared";
import { useLayoutEffect, useRef, type HTMLAttributes, type IframeHTMLAttributes } from "react";
import { mailDocument } from "../pages/mail/mailHtml";

// Trusted Types sulla nuova app (cassaforte nel browser, revisione I-4,
// design §2.3): l'UNICO punto del renderer che scrive o interpreta HTML.
// La politica `stubwise-html` (nominata nella direttiva `trusted-types`) è
// PRIVATA di questo modulo: nasce al suo import e non esce mai. Il suo
// `createHTML` accetta soltanto ciò che il modulo stesso ha appena preparato,
// in tre modi stretti:
// - `TrustedSvg` (WireframeBlock, PrintView): l'uscita del sanitizzatore degli
//   schizzi, ricontrollata (`sanitizeWireframeSvg` deve restituirla identica);
// - `parseInertHtml` (la posta, l'incolla HTML): l'HTML grezzo, fidato SOLO
//   per un `DOMParser`, che dà un documento inerte; il valore fidato non esce;
// - `TrustedMailFrame` (la posta): il documento della cornice che il modulo
//   compone da sé dall'HTML grezzo (`mailDocument`: bonificato), scritto nel
//   `srcdoc` di un iframe senza permessi.
// Il QR del TOTP non passa di qui: è un `<img>` con un `data:`. Una guardia
// sul sorgente vieta le scritture di HTML fuori da questo file, e dice chi
// può importare quale funzione.

type Trusted = unknown;
type Policy = { createHTML: (input: string) => Trusted };
type Factory = { createPolicy: (name: string, rules: { createHTML: (input: string) => string }) => Policy };

/** Ciò che il modulo sta per rendere fidato, in questo istante (sincrono). */
let expected: { kind: "sketch" } | { kind: "exact"; value: string } | null = null;

function accept(input: string): string {
  const want = expected;
  expected = null;
  if (want?.kind === "sketch") {
    if (sanitizeWireframeSvg(input) === input) return input;
  } else if (want?.kind === "exact" && want.value === input) {
    return input;
  }
  throw new TypeError("stubwise_html_refused");
}

const factory = (globalThis as { trustedTypes?: Factory }).trustedTypes;
const policy: Policy | null = factory ? factory.createPolicy("stubwise-html", { createHTML: accept }) : null;

function trusted(input: string, how: NonNullable<typeof expected>): Trusted {
  expected = how;
  try {
    // Senza Trusted Types (i test, un browser senza) la stessa regola, sulla stringa.
    return policy ? policy.createHTML(input) : accept(input);
  } finally {
    expected = null;
  }
}

/** Uno schizzo GIÀ ripulito come HTML fidato; uno che non regge lancia `stubwise_html_refused`. */
export function trustedSketchHtml(svg: string): Trusted {
  return trusted(svg, { kind: "sketch" });
}

/** Un contenitore con dentro uno schizzo SVG ripulito; uno che non regge non scrive niente. */
export function TrustedSvg({ svg, ...rest }: { svg: string } & HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      el.innerHTML = trustedSketchHtml(svg) as string;
    } catch {
      el.textContent = "";
    }
  }, [svg]);
  return <div ref={ref} {...rest} />;
}

/** Un documento INERTE dall'HTML grezzo (non esegue niente, non entra nella pagina). */
export function parseInertHtml(html: string): Document {
  return new DOMParser().parseFromString(trusted(html, { kind: "exact", value: html }) as string, "text/html");
}

/**
 * L'iframe dell'originale di un'email: il documento lo compone QUESTO modulo
 * dall'HTML grezzo (`mailDocument`, bonificato) e solo quello diventa fidato.
 */
export function TrustedMailFrame({
  html,
  images,
  ...rest
}: { html: string; images: boolean } & Omit<IframeHTMLAttributes<HTMLIFrameElement>, "srcDoc">) {
  const ref = useRef<HTMLIFrameElement>(null);
  useLayoutEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const doc = mailDocument(html, images);
    try {
      frame.srcdoc = trusted(doc, { kind: "exact", value: doc }) as string;
    } catch {
      frame.removeAttribute("srcdoc");
    }
  }, [html, images]);
  return <iframe ref={ref} {...rest} />;
}
