import { useEffect, useRef, useState } from "react";

interface CopyButtonProps {
  /** Testo da mettere negli appunti. */
  text: string;
  /** Nome accessibile del bottone, es. "Copia chiave di ingestion". */
  label: string;
}

/** Per quanto resta accesa la conferma "Copiato" dopo il click. */
const FEEDBACK_MS = 2000;

/**
 * Bottone copia-negli-appunti in stile pannello strumenti: etichetta mono,
 * conferma "Copiato" temporanea al posto del testo. Il fallimento della
 * clipboard (permessi, contesto non sicuro) mostra "Errore" senza lanciare.
 */
export function CopyButton({ text, label }: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), FEEDBACK_MS);
  }

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => void handleCopy()}
      className={`shrink-0 rounded-sm border px-2 py-1 font-mono text-[10px] tracking-[0.14em] uppercase transition-colors ${
        state === "copied"
          ? "border-ok/40 text-ok"
          : state === "failed"
            ? "border-danger/40 text-danger"
            : "border-line-strong text-fg-muted hover:border-signal-dim hover:text-fg"
      }`}
    >
      {state === "copied" ? "Copiato" : state === "failed" ? "Errore" : "Copia"}
    </button>
  );
}
