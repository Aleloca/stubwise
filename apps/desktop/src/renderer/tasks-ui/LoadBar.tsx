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
 */
export function LoadBar({
  weight = 0,
  max,
  unsized,
  segments,
  label,
}: {
  weight?: number;
  max: number;
  unsized: number;
  segments?: LoadSegment[];
  label?: string;
}) {
  const { t } = useTranslation();
  const parts: LoadSegment[] = segments ?? [{ weight, tone: "strong" }];
  let used = 0;
  const widths = parts.map((s) => {
    const share = max > 0 ? Math.max(0, Math.min(s.weight / max, 1 - used)) : 0;
    used += share;
    return share * 100;
  });
  const total = Math.round(used * 100);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        role="img"
        aria-label={t("taskUi.load.relative", {
          label: label ?? t("taskUi.load.label"),
          percent: total,
        })}
        className="flex h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-ink/8"
      >
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
      {unsized > 0 && (
        <span className="shrink-0 text-xs whitespace-nowrap text-ink-muted">
          {t("taskUi.load.unsized", { count: unsized })}
        </span>
      )}
    </span>
  );
}
