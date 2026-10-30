import { useTranslation } from "react-i18next";
import { WhoCanLink } from "../../../components/WhoCanLink";
import { OpenCircleGlyph } from "../../preferences/glyphs";

// I pezzi comuni delle schede della voce AI (shape admin-ai.md): la riga di
// sola lettura col suo «Who?», gli importi, le parole dei rifiuti.

/** Chi scrive una scheda: Providers con `ai_providers.manage`, le altre con `settings.manage`. */
export type AiWriteScope = "providers" | "settings";

const ACTION_OF: Record<AiWriteScope, string> = {
  providers: "manageAiProviders",
  settings: "manageSettings",
};

/** «Who?» per un'azione spenta della scheda. */
export function AiWhoCan({ scope }: { scope: AiWriteScope }) {
  return <WhoCanLink action={ACTION_OF[scope]} projectId={null} />;
}

/**
 * La riga di una scheda letta senza il suo permesso di scrittura: il
 * cerchio vuoto, la frase e «Who?». Una sola, in testa; i controlli restano
 * visibili e spenti.
 */
export function ReadOnlyLine({ scope }: { scope: AiWriteScope }) {
  const { t } = useTranslation();
  return (
    <p data-read-only={scope} className="flex items-start gap-1.5 text-sm text-ink-muted">
      <span className="mt-[2px] shrink-0">
        <OpenCircleGlyph size={12} />
      </span>
      <span className="min-w-0">
        {t(`admin.ai.readOnly.${scope}`)} <AiWhoCan scope={scope} />
      </span>
    </p>
  );
}

/**
 * Un rifiuto del livello dati in parole, dove è partita l'azione (shape §5).
 * `invalid` lo traduce chi chiama (dipende dal campo); la riconferma chiusa
 * non dice niente qui: lo dice già il dialogo («Nothing was changed.»).
 */
export function useAiRefusalWords() {
  const { t } = useTranslation();
  return (error: string): string => {
    if (error === "reauth_cancelled") return "";
    if (error === "forbidden") return t("admin.ai.forbidden");
    return t("admin.ai.saveFailed");
  };
}

/** Lo scheletro di una scheda: righe alte quanto le vere. */
export function AiSkeleton({ rows, height = 64 }: { rows: number; height?: number }) {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe mt-4 border-t border-rule">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          style={{ height }}
          className="flex items-center gap-4 border-b border-rule px-1"
        >
          <span className={`h-2.5 ${bar}`} style={{ width: `${28 + ((i * 13) % 24)}%` }} />
          <span className={`ml-auto h-2.5 w-24 ${bar}`} />
        </div>
      ))}
    </div>
  );
}
