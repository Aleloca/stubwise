import { useState } from "react";

/**
 * Avatar tondo riusabile: mostra l'immagine (es. avatar Slack) quando `src` è
 * valorizzato, altrimenti — o al fallire del caricamento — un cerchio con le
 * iniziali derivate da `label` su uno sfondo a colore deterministico (hash
 * della label). Componente puro: nessuna query interna, lo si alimenta con
 * `src`/`label` risolti dal chiamante.
 */
export function Avatar({
  src,
  label,
  size = 24,
}: {
  src?: string | null;
  label: string;
  size?: number;
}) {
  // `failed` traccia un errore di caricamento dell'immagine: una volta fallita
  // si passa al fallback iniziali e non si ritenta (evita loop di onError).
  const [failed, setFailed] = useState(false);

  if (src && !failed) {
    return (
      <img
        src={src}
        alt={label}
        loading="lazy"
        width={size}
        height={size}
        onError={() => setFailed(true)}
        className="inline-block shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  const bg = colorForLabel(label);
  return (
    <span
      data-avatar-fallback
      role="img"
      aria-label={label}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-mono font-semibold text-ink-950 select-none"
      style={{
        width: size,
        height: size,
        backgroundColor: bg,
        // Le iniziali scalano con la dimensione del cerchio.
        fontSize: Math.max(9, Math.round(size * 0.42)),
      }}
    >
      {initials(label)}
    </span>
  );
}

/**
 * Iniziali da una label: se è un'email si usa la parte locale (prima della @);
 * per un nome con più parole si prendono le iniziali delle prime due, altrimenti
 * le prime due lettere della singola parola. Sempre maiuscole.
 */
function initials(label: string): string {
  const local = label.includes("@") ? label.slice(0, label.indexOf("@")) : label;
  const words = local.split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) {
    return words[0]!.slice(0, 2).toUpperCase();
  }
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/**
 * Palette di sfondi del fallback: tonalità coerenti col tema control-room,
 * sufficientemente sature da reggere il testo scuro (text-ink-950).
 */
const PALETTE = [
  "#f5a623", // signal
  "#4ad295", // ok
  "#5aa9e6", // azzurro
  "#c08adb", // viola
  "#e6845a", // arancio bruciato
  "#7fd16a", // verde
  "#e6c25a", // ocra
  "#5ad1c8", // teal
] as const;

/** Colore deterministico per una label: hash djb2 → indice nella palette. */
function colorForLabel(label: string): string {
  let hash = 5381;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 33) ^ label.charCodeAt(i);
  }
  const index = Math.abs(hash) % PALETTE.length;
  return PALETTE[index]!;
}
