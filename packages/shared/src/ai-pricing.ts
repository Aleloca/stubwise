/**
 * Le tariffe dei modelli Anthropic, in USD per milione di token (review F3,
 * punto 8): le chiamate dirette del server (la chat, la bozza di Claude) non
 * ricevono un costo dall'API, e senza una stima il budget mensile d'istanza le
 * contava zero. Fonte: il listino dell'API di prima parte (cache del 6 ott
 * 2026). Dove il listino non dà la lettura della cache esplicita si usa il
 * rapporto standard (0,1× dell'input); la scrittura (TTL 5 minuti) è 1,25×.
 * Una STIMA: il conto vero resta quello di Anthropic.
 *
 * Modulo foglia: niente import.
 */

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const p = (input: number, output: number, cacheRead = input * 0.1): ModelPricing => ({ input, output, cacheRead, cacheWrite: input * 1.25 });

export const AI_MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-fable-5-1": p(10, 50, 0.25),
  "claude-opus-5-5": p(4, 20, 0.2),
  "claude-sonnet-5-5": p(2, 10, 0.2),
  "claude-haiku-5-5": p(0.1, 0.5),
  "claude-opus-4-8": p(5, 25),
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Il costo stimato di una chiamata; `null` per un modello senza tariffa (mai uno zero inventato). */
export function estimateCostUsd(model: string, tokens: TokenUsage): number | null {
  const price = AI_MODEL_PRICING[model];
  if (!price) return null;
  return (
    (tokens.inputTokens * price.input +
      tokens.outputTokens * price.output +
      tokens.cacheReadTokens * price.cacheRead +
      tokens.cacheCreationTokens * price.cacheWrite) /
    1_000_000
  );
}
