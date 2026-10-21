import { aiModelSettings, instanceSettings, type Db } from "@stubwise/db";
import { AI_MODEL_CHOICES, type AiOperation } from "@stubwise/shared";
import { eq } from "drizzle-orm";

/**
 * Modello per tipo di lavoro (design 2026-10-21-modelli-e-consumi, §2).
 *
 * Precedenza: `ai_model_settings` (scelta dell'admin) → modello che il
 * chiamante passa già oggi (env del worker) → default del CLI. Questo modulo
 * fa il primo passo; il secondo è il `fallback`, che `TrackingAgentRunner`
 * prende da `opts.model`.
 */

/** Logger minimale (sottoinsieme di pino / `console`), come gli altri del worker. */
export interface ModelSettingsLogger {
  warn(obj: unknown, msg?: string): void;
}

export interface ModelResolver {
  /**
   * Modello da usare per `operation`: quello impostato dall'admin se valido,
   * altrimenti `fallback`. Non lancia mai.
   */
  resolve(operation: AiOperation, fallback: string | undefined): Promise<string | undefined>;
}

/** Legge il valore grezzo della riga (undefined = nessuna riga). */
export type ReadModelSetting = (operation: AiOperation) => Promise<string | undefined>;

const KNOWN_MODELS: ReadonlySet<string> = new Set(AI_MODEL_CHOICES);

/**
 * Resolver che legge `ai_model_settings` a OGNI chiamata, senza cache: un
 * cambio dalla UI vale dal run successivo, senza riavviare il worker (una
 * query sulla PK per run dell'agente è trascurabile rispetto al run).
 *
 * Un valore fuori da `AI_MODEL_CHOICES` — il CHECK lo impedisce oggi, ma una
 * riga scritta prima di un deploy che ha ristretto il catalogo resta lì — non
 * arriva MAI al CLI: si usa `fallback` con un warn. Anche un errore del DB
 * ricade su `fallback`: scegliere il modello non deve far fallire un lavoro.
 *
 * `read` è iniettabile solo per i test (il CHECK non lascia scrivere un
 * valore fuori catalogo); in produzione è la query sulla tabella.
 */
export function createModelResolver(
  db: Db,
  log: ModelSettingsLogger,
  read: ReadModelSetting = async (operation) => {
    const [row] = await db
      .select({ model: aiModelSettings.model })
      .from(aiModelSettings)
      .where(eq(aiModelSettings.operation, operation));
    return row?.model;
  },
): ModelResolver {
  return {
    async resolve(operation, fallback) {
      let value: string | undefined;
      try {
        value = await read(operation);
      } catch (err) {
        log.warn(
          `[stubwise-worker] modello per ${operation}: lettura di ai_model_settings fallita, uso il default (${String(err)})`,
        );
        return fallback;
      }
      if (value === undefined) return fallback;
      if (!KNOWN_MODELS.has(value)) {
        log.warn(
          `[stubwise-worker] modello per ${operation}: "${value}" non è nel catalogo, uso il default`,
        );
        return fallback;
      }
      return value;
    },
  };
}

/**
 * Pubblica in `instance_settings.worker_model_defaults` i modelli che il
 * worker userebbe SENZA impostazione (env + default nel codice), così la UI
 * può mostrare «predefinito: …» accanto a ogni operazione. Scritto all'avvio
 * del worker; BEST-EFFORT: un errore non impedisce al worker di partire, la
 * UI mostra solo meno informazioni.
 */
export async function writeWorkerModelDefaults(
  db: Db,
  defaults: Record<AiOperation, string>,
  log: ModelSettingsLogger = console,
): Promise<void> {
  try {
    await db
      .update(instanceSettings)
      .set({ workerModelDefaults: defaults })
      .where(eq(instanceSettings.id, 1));
  } catch (err) {
    log.warn(`[stubwise-worker] worker_model_defaults non scritti: ${String(err)}`);
  }
}
