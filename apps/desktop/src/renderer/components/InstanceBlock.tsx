import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { usePeople } from "../data/queries";
import type { AiBlock } from "../data/types";
import { NOW } from "../notifications/time";
import { WhoCanLink } from "./WhoCanLink";

// Le impostazioni d'istanza dove si sentono (area 9b, shape
// instance-effects.md): un blocco è una frase sola, sempre nello stesso
// posto — sopra il controllo che ferma —, con lo stesso glifo dappertutto
// (○ informazione, ‖ pausa, ◷ in attesa) e il «Who?» quando lo sblocca un
// permesso. Due famiglie di frasi, mai mescolate: budget e coda. Nessun
// colore di stato: per chi lavora è un'attesa, non un guasto.

const K = "instanceEffects";

/** «da ieri alle 18:00», «da oggi alle 9:30», «dal 22 ott, 18:00»: relativo all'adesso del prototipo. */
export function sinceText(t: TFunction, iso: string, language: string): string {
  const day = (x: string) => Date.parse(`${x.slice(0, 10)}T00:00:00Z`);
  const days = Math.round((day(NOW) - day(iso)) / 86_400_000);
  const time = iso.slice(11, 16);
  if (days === 0) return t(`${K}.since.today`, { time });
  if (days === 1) return t(`${K}.since.yesterday`, { time });
  const date = new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(iso));
  return t(`${K}.since.date`, { date });
}

/** Il nome di chi ha messo la pausa, con «(deactivated)» se nel frattempo è stato disattivato. */
export function usePauserName(block: AiBlock | null): string {
  const { t } = useTranslation();
  const people = usePeople().data;
  if (block?.reason !== "queue_paused") return "";
  const deactivated = people?.find((p) => p.id === block.byId)?.deactivated === true;
  return deactivated ? t(`${K}.deactivated`, { name: block.byName }) : block.byName;
}

/** La riga di stato di un lavoro in attesa: «Waiting: queue paused by Roberta Fontana». */
export function waitingText(t: TFunction, block: AiBlock, name: string): string {
  return block.reason === "monthly_budget"
    ? t(`${K}.budget.waiting`)
    : t(`${K}.queue.waiting`, { name });
}

/**
 * Una frase con «Who?» in coda: l'ultima parola e il link vanno a capo
 * insieme, così «Who?» non resta mai da solo su una riga (shape §6).
 */
export function WithWho({ text }: { text: string }) {
  const cut = text.lastIndexOf(" ");
  return (
    <>
      {cut > 0 ? `${text.slice(0, cut)} ` : ""}
      <span className="whitespace-nowrap">
        {cut > 0 ? text.slice(cut + 1) : text}{" "}
        <WhoCanLink action="manageSettings" projectId={null} />
      </span>
    </>
  );
}

function Line({
  glyph,
  children,
  kind,
}: {
  glyph: string;
  children: ReactNode;
  kind: AiBlock["reason"] | "storage_off" | "refused";
}) {
  return (
    <p data-ai-block={kind} className="flex gap-2 text-sm text-ink-muted">
      <span aria-hidden="true" className="w-3 shrink-0 text-center">
        {glyph}
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}

/**
 * La frase di un blocco sopra il controllo che ferma. Budget: «○ The
 * monthly AI budget is used up… Who?» (il controllo è spento). Coda: «‖
 * STW's queue is paused by Roberta Fontana since yesterday at 18:00. If you
 * start now…» (il controllo resta acceso: niente «Who?»). `chat`: la frase
 * del composer di «Chiedi a Claude», che la pausa non tocca.
 */
export function AiBlockLine({
  block,
  projectCode,
  chat = false,
}: {
  block: AiBlock;
  projectCode: string;
  chat?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const name = usePauserName(block);
  if (block.reason === "monthly_budget") {
    return (
      <Line glyph="○" kind="monthly_budget">
        <WithWho text={t(chat ? `${K}.budget.chat` : `${K}.budget.start`)} />
      </Line>
    );
  }
  return (
    <Line glyph="‖" kind="queue_paused">
      {t(`${K}.queue.start`, {
        code: projectCode,
        name,
        since: sinceText(t, block.since, i18n.language),
      })}
    </Line>
  );
}

/** Un avvio rifiutato perché il budget è finito nel frattempo: «✕ Claude didn't start…». */
export function RefusedLine({ chat = false }: { chat?: boolean }) {
  const { t } = useTranslation();
  return (
    <Line glyph="✕" kind="refused">
      <span role="alert">{t(chat ? `${K}.budget.chatRefused` : `${K}.budget.refused`)}</span>
    </Line>
  );
}

/** Il Drive con i caricamenti spenti: «○ Uploads are off on this instance… Who?». */
export function UploadsOffLine() {
  const { t } = useTranslation();
  return (
    <Line glyph="○" kind="storage_off">
      <WithWho text={t(`${K}.storage.drive`)} />
    </Line>
  );
}

/** Un errore di scrittura è il rifiuto per budget (il budget è finito fra la lettura e il clic). */
export const isBudgetRefusal = (error: unknown): boolean =>
  error instanceof Error && error.message === "invalid: monthly_budget";
