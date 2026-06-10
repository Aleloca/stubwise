import { z } from "zod";
import { formatDateTime } from "../lib/format";

/**
 * Forma attesa del payload tecnico scritto dall'ingestion SDK. `loose`:
 * il payload è jsonb libero, i campi extra non devono far fallire il parse.
 */
const payloadSchema = z
  .object({
    message: z.string().optional(),
    stack: z.string().optional(),
    url: z.string().optional(),
    release: z.string().optional(),
    environment: z.string().optional(),
    userAgent: z.string().optional(),
    timestamp: z.string().optional(),
    breadcrumbs: z
      .array(
        z.object({
          type: z.string(),
          message: z.string(),
          timestamp: z.string().optional(),
        }),
      )
      .optional(),
  })
  .loose();

/**
 * Payload tecnico di un ticket nato da un errore SDK: metadati a coppie
 * chiave/valore, stack trace in mono e tabella dei breadcrumb. Se il JSON
 * non ha la forma attesa si mostra grezzo, senza perdere informazione.
 */
export function TechnicalPayload({ payload }: { payload: unknown }) {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    return <pre className={preClass}>{JSON.stringify(payload, null, 2)}</pre>;
  }
  const data = parsed.data;

  const rows: [string, string | undefined][] = [
    ["Messaggio", data.message],
    ["URL", data.url],
    ["Release", data.release],
    ["Ambiente", data.environment],
    ["User agent", data.userAgent],
    ["Timestamp", data.timestamp ? formatDateTime(data.timestamp) : undefined],
  ];
  const visibleRows = rows.filter((row): row is [string, string] => Boolean(row[1]));

  return (
    <div className="space-y-4">
      {visibleRows.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
          {visibleRows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="font-mono text-[11px] leading-6 tracking-[0.12em] text-fg-faint uppercase">
                {label}
              </dt>
              <dd className="font-mono text-[12px] leading-6 break-all text-fg-muted">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {data.stack && (
        <div>
          <p className={subheadClass}>Stack trace</p>
          <pre className={preClass}>{data.stack}</pre>
        </div>
      )}

      {data.breadcrumbs && data.breadcrumbs.length > 0 && (
        <div>
          <p className={subheadClass}>Breadcrumb ({data.breadcrumbs.length})</p>
          <table className="w-full border-collapse">
            <tbody>
              {data.breadcrumbs.map((crumb, index) => (
                <tr key={index} className="border-b border-line last:border-b-0">
                  <td className="py-1 pr-3 align-top font-mono text-[11px] tracking-[0.08em] whitespace-nowrap text-fg-faint uppercase">
                    {crumb.type}
                  </td>
                  <td className="py-1 pr-3 font-mono text-[12px] break-all text-fg-muted">
                    {crumb.message}
                  </td>
                  <td className="py-1 text-right align-top font-mono text-[11px] whitespace-nowrap text-fg-faint">
                    {crumb.timestamp ? formatDateTime(crumb.timestamp) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const subheadClass = "mb-1.5 font-mono text-[11px] tracking-[0.16em] text-fg-faint uppercase";
const preClass =
  "overflow-x-auto rounded-sm border border-line bg-ink-950/70 p-3 font-mono text-[12px] leading-relaxed text-fg-muted";
