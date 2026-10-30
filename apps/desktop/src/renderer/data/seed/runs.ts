import type { Conversation, ModelUsage, RunProvider } from "../types";

// Con chi gira ogni sessione di lavoro, quanto ha consumato e, se è
// fallita, il riassunto del fallimento. Valori finti: nomi di account e
// chiavi inventati (mai un segreto), token e costi plausibili, non misurati.

/** L'account in abbonamento del team: lo usano le sessioni nuove. */
export const TEAM_ACCOUNT: RunProvider = { kind: "account", name: "Team Max", id: "prv-team-max" };
const BILLING_KEY: RunProvider = { kind: "api_key", name: "Billing key", id: "prv-billing-key" };

const sonnet = (
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  costUsd: number,
): ModelUsage => ({
  model: "claude-sonnet-4-5",
  inputTokens,
  outputTokens,
  cacheReadTokens,
  costUsd,
});
const haiku = (
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  costUsd: number,
): ModelUsage => ({
  model: "claude-haiku-4-5",
  inputTokens,
  outputTokens,
  cacheReadTokens,
  costUsd,
});

export const RUN_META: Record<
  string,
  Pick<Conversation, "provider" | "usage" | "failureSummary">
> = {
  "cv-run-stw-13": { provider: TEAM_ACCOUNT, usage: [sonnet(48_200, 3_900, 112_000, 0.41)] },
  "cv-run-aud-3": { provider: TEAM_ACCOUNT, usage: [sonnet(61_500, 4_700, 140_300, 0.52)] },
  "cv-run-aud-5": {
    provider: BILLING_KEY,
    usage: [sonnet(182_400, 21_300, 402_000, 2.18), haiku(12_100, 1_400, 0, 0.02)],
  },
  "cv-run-stw-3": {
    provider: TEAM_ACCOUNT,
    usage: [sonnet(240_800, 28_600, 611_500, 2.94), haiku(18_300, 2_100, 0, 0.03)],
  },
  "cv-run-mkx-11": { provider: TEAM_ACCOUNT, usage: [sonnet(39_700, 5_200, 88_400, 0.39)] },
  "cv-run-aud-4": { provider: BILLING_KEY, usage: [sonnet(97_600, 9_800, 230_100, 1.07)] },
  "cv-run-stw-3-guide": { provider: TEAM_ACCOUNT, usage: [sonnet(64_800, 7_300, 150_200, 0.71)] },
  "cv-run-stw-1-first": { provider: TEAM_ACCOUNT, usage: [sonnet(52_300, 4_100, 98_000, 0.44)] },
  "cv-run-stw-1": {
    provider: TEAM_ACCOUNT,
    usage: [sonnet(311_000, 34_900, 820_400, 3.71), haiku(22_800, 2_600, 0, 0.04)],
  },
  "cv-run-stw-7": {
    provider: TEAM_ACCOUNT,
    usage: [sonnet(128_900, 12_400, 301_700, 1.39)],
    failureSummary:
      "The filters page tests failed twice: they expect public filters in a different order than the plan.",
  },
  // Area 9b: il lavoro fallito ieri (Stato dell'istanza, «Retry»).
  "cv-run-acq-3": {
    provider: TEAM_ACCOUNT,
    usage: [sonnet(74_100, 6_800, 160_900, 0.83)],
    failureSummary:
      "Two invoice totals didn't match the billing export after two attempts: both customers have a credit note the plan didn't account for.",
  },
};
