import { useTranslation } from "react-i18next";
import type { ServerDisk } from "../../data/types";
import { bytes } from "./format";
import { TroubleGlyph } from "./glyphs";
import { Part } from "./Part";

// I dischi (shape servers.md §3, «Disks»): una riga per mount, la barra
// d'inchiostro, `warning` oltre la soglia del disco e `critical` sopra il
// 95%. La parola dice lo stesso del colore («above the alert»): il colore
// non è mai l'unico segnale. L'andamento sta nei grafici.

const CRITICAL_PCT = 95;

export function DisksPanel({
  disks,
  threshold,
}: {
  disks: ServerDisk[];
  threshold: number | null;
}) {
  const { t, i18n } = useTranslation();
  return (
    <Part id="disks" title={t("servers.index.disks")}>
      {disks.length === 0 ? (
        <p className="border-t border-rule py-3 pl-3 text-md text-ink-muted">
          {t("servers.disks.empty")}
        </p>
      ) : (
        <ul aria-label={t("servers.index.disks")} className="flex flex-col border-t border-rule">
          {disks.map((d) => {
            const pct = d.totalBytes > 0 ? Math.round((d.usedBytes / d.totalBytes) * 100) : 0;
            const level =
              pct > CRITICAL_PCT
                ? "critical"
                : threshold !== null && pct > threshold
                  ? "warning"
                  : null;
            return (
              <li
                key={d.mount}
                data-disk={d.mount}
                className="flex min-h-10 items-center gap-4 border-b border-rule px-3"
              >
                <span title={d.mount} className="num w-48 min-w-0 truncate text-md text-ink">
                  {d.mount}
                </span>
                <span
                  role="meter"
                  aria-label={t("servers.disks.meter", { mount: d.mount })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                  className="relative h-1.5 w-40 shrink-0 overflow-hidden rounded-full bg-ink/10"
                >
                  <span
                    className={`absolute inset-y-0 left-0 rounded-full ${level === "critical" ? "bg-critical" : level === "warning" ? "bg-warning" : "bg-ink"}`}
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </span>
                <span className="num text-sm text-ink-muted">
                  {t("servers.disks.usage", {
                    used: bytes(d.usedBytes, i18n.language),
                    total: bytes(d.totalBytes, i18n.language),
                    pct,
                  })}
                </span>
                {level && (
                  <span className="flex items-center gap-1 text-sm text-ink">
                    <TroubleGlyph />
                    {t(
                      level === "critical"
                        ? "servers.disks.almostFull"
                        : "servers.disks.aboveAlert",
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Part>
  );
}
