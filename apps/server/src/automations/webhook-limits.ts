import type { AutomationWebhookLimits } from "@stubwise/shared";

/**
 * IL TETTO DEL WEBHOOK IN ARRIVO (area 7, F4, D3 e F4-2 = c). Lo sceglie chi
 * gestisce l'automazione (`automations.webhook_per_minute` e
 * `webhook_per_day`, null = il default), e non supera MAI il massimo
 * d'istanza *(O, 46)*: una scelta più alta si salva com'è, ma vale il
 * massimo. Il massimo è una env del server, così un'istanza può stringerlo:
 * un indirizzo pubblico non resta mai senza freno.
 */

export const WEBHOOK_DEFAULT_PER_MINUTE = 60;
export const WEBHOOK_DEFAULT_PER_DAY = 5_000;
const FALLBACK_MAX_PER_MINUTE = 600;
const FALLBACK_MAX_PER_DAY = 50_000;

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Il massimo d'istanza (letto a ogni chiamata: i test cambiano l'env). */
export function webhookMax(): { perMinute: number; perDay: number } {
  return {
    perMinute: positiveEnv("AUTOMATION_WEBHOOK_MAX_PER_MINUTE", FALLBACK_MAX_PER_MINUTE),
    perDay: positiveEnv("AUTOMATION_WEBHOOK_MAX_PER_DAY", FALLBACK_MAX_PER_DAY),
  };
}

/** Il tetto che vale davvero: la scelta (o il default), mai oltre il massimo d'istanza. */
export function effectiveWebhookLimits(chosen: { webhookPerMinute: number | null; webhookPerDay: number | null }): { perMinute: number; perDay: number } {
  const max = webhookMax();
  return {
    perMinute: Math.min(chosen.webhookPerMinute ?? WEBHOOK_DEFAULT_PER_MINUTE, max.perMinute),
    perDay: Math.min(chosen.webhookPerDay ?? WEBHOOK_DEFAULT_PER_DAY, max.perDay),
  };
}

/** La forma per i client: la scelta, il default, il massimo e ciò che vale. */
export function webhookLimitsView(chosen: { webhookPerMinute: number | null; webhookPerDay: number | null }): AutomationWebhookLimits {
  const max = webhookMax();
  return {
    perMinute: chosen.webhookPerMinute,
    perDay: chosen.webhookPerDay,
    defaultPerMinute: WEBHOOK_DEFAULT_PER_MINUTE,
    defaultPerDay: WEBHOOK_DEFAULT_PER_DAY,
    maxPerMinute: max.perMinute,
    maxPerDay: max.perDay,
    effective: effectiveWebhookLimits(chosen),
  };
}
