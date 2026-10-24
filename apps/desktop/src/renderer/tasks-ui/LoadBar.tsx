import { useTranslation } from "react-i18next";

/** Un tratto della barra: `strong` = inchiostro pieno, `faint` = inchiostro al 30%. */
export interface LoadSegment {
  weight: number;
  tone: "strong" | "faint";
  /** Cosa rappresenta (es. «This project», «Other projects»), nel `title` del tratto. */
  label?: string;
}

const pct = (n: number) => `${Math.round(n * 100) / 100}%`;

/**
 * Il carico in taglie: una barra proporzionale a `max` (il più carico della
 * vista, non una capacità), MAI un numero di peso. Le task senza stima non
 * pesano: compaiono accanto come «+N no estimate». Con `segments` la barra
 * ha più tratti nella stessa traccia — Planning: questo progetto (pieno) e
 * gli altri progetti (al 30%), senza un colore nuovo. I tratti oltre `max`
 * vengono tagliati: la barra non esce mai dalla sua traccia.
 *
 * Con `marker` la barra si confronta con un riferimento (la settimana solita,
 * My week): un filetto d'inchiostro alto quanto la traccia lo segna, e
 * `relativeLabel` riceve la percentuale rispetto al riferimento, non a `max`.
 */
export function LoadBar({
  weight = 0,
  max,
  unsized,
  segments,
  label,
  marker,
  relativeLabel,
  title,
}: {
  weight?: number;
  max: number;
  unsized: number;
  segments?: LoadSegment[];
  label?: string;
  marker?: { weight: number; label: string };
  relativeLabel?: (percent: number) => string;
  /** Il `title` della traccia (cosa confronta la barra). */
  title?: string;
}) {
  const { t } = useTranslation();
  const parts: LoadSegment[] = segments ?? [{ weight, tone: "strong" }];
  let used = 0;
  const widths = parts.map((s) => {
    const share = max > 0 ? Math.max(0, Math.min(s.weight / max, 1 - used)) : 0;
    used += share;
    return share * 100;
  });
  const sum = parts.reduce((acc, s) => acc + Math.max(0, s.weight), 0);
  const percent =
    marker && marker.weight > 0 ? Math.round((sum / marker.weight) * 100) : Math.round(used * 100);
  const markerAt = marker && max > 0 ? Math.min(1, marker.weight / max) * 100 : null;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        role="img"
        title={title}
        aria-label={
          relativeLabel
            ? relativeLabel(percent)
            : t("taskUi.load.relative", { label: label ?? t("taskUi.load.label"), percent })
        }
        className="relative flex h-1.5 min-w-8 flex-1 rounded-full bg-ink/8"
      >
        <span className="flex h-full w-full overflow-hidden rounded-full">
          {parts.map((s, i) => (
            <span
              key={i}
              data-load-segment={s.tone}
              title={s.label}
              style={{ width: pct(widths[i]!) }}
              className={`h-full transition-[width] duration-[var(--duration)] ease-out ${s.tone === "strong" ? "bg-ink" : "bg-ink/30"}`}
            />
          ))}
        </span>
        {markerAt !== null && (
          // Il filetto della «solita» sporge di 2 px sopra e sotto la traccia.
          <span
            data-load-marker
            title={marker!.label}
            style={{ left: pct(markerAt) }}
            className="absolute -top-0.5 -bottom-0.5 w-px -translate-x-1/2 bg-ink-muted"
          />
        )}
      </span>
      {unsized > 0 && (
        <span className="shrink-0 text-xs whitespace-nowrap text-ink-muted">
          {t("taskUi.load.unsized", { count: unsized })}
        </span>
      )}
    </span>
  );
}
