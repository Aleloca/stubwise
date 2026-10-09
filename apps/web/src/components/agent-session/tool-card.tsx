import { describeAgentActivity, type TranscriptItem } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { CollapsibleSection } from "../collapsible-section";
import { catalogKey } from "./i18n-key";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** Oltre questa lunghezza l'input mostrato si tronca: il risultato lo tronca già il worker. */
const MAX_INPUT_CHARS = 4000;

function formatInput(input: unknown): { text: string; truncated: boolean } {
  let text: string;
  try {
    text = typeof input === "string" ? input : (JSON.stringify(input, null, 2) ?? "");
  } catch {
    text = String(input);
  }
  return text.length > MAX_INPUT_CHARS
    ? { text: `${text.slice(0, MAX_INPUT_CHARS)}…`, truncated: true }
    : { text, truncated: false };
}

/**
 * Un'azione dell'agente, compatta: la riga dice COSA ha fatto (stessa regola
 * dell'«ultima azione», `describeAgentActivity`, ma all'imperativo: la card
 * può riguardare un'azione finita) e si apre su input e risultato. Un tool
 * senza risultato è in corso solo in una sessione viva.
 */
export function ToolCard({ item, live }: { item: ToolItem; live: boolean }) {
  const { t } = useTranslation("agents");
  const activity = describeAgentActivity({
    type: "tool_use",
    data: { name: item.name, input: item.input },
  });
  const kind = catalogKey(activity.kind);
  const label = t(`tool.kind.${kind}`, { target: activity.target ?? "" }).trim();
  // Per `other` il target È il nome: ripeterlo sarebbe rumore.
  const meta = [
    kind === "other" ? null : item.name,
    item.result?.isError ? t("tool.error") : null,
    // Senza risultato è «in corso» solo finché la sessione è viva.
    item.result === null && live ? "…" : null,
  ]
    .filter((v): v is string => v !== null)
    .join(" · ");
  const input = formatInput(item.input);

  return (
    <CollapsibleSection title={label} meta={meta || undefined} preserveCase>
      <div className="flex flex-col gap-3">
        <div>
          <p className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">
            {t("tool.showInput")}
          </p>
          <pre className="mt-1 max-h-80 overflow-auto font-mono text-[12px] whitespace-pre-wrap break-words text-fg-muted">
            {input.text}
          </pre>
          {input.truncated && (
            <p className="mt-1 font-mono text-[11px] text-fg-faint">{t("truncatedInput")}</p>
          )}
        </div>
        {item.result !== null && (
          <div>
            <p className="font-mono text-[11px] tracking-[0.14em] text-fg-faint uppercase">
              {t("tool.showResult")}
            </p>
            <pre
              className={`mt-1 max-h-80 overflow-auto font-mono text-[12px] whitespace-pre-wrap break-words ${
                item.result.isError ? "text-danger" : "text-fg-muted"
              }`}
            >
              {item.result.content}
            </pre>
            {item.result.truncated && (
              <p className="mt-1 font-mono text-[11px] text-fg-faint">{t("tool.truncated")}</p>
            )}
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
