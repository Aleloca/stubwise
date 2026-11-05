/**
 * Il «a»/«ad» italiano davanti a un codice: lo sceglie la frase col contesto
 * `vowel` di i18next («ad ACQ», «a STW»). Una regola sola per tutte le frasi
 * che lo vogliono (review finale 10b, 8); in inglese il contesto non ha una
 * sua chiave e vale quella base.
 */
export const vowelContext = (code: string | null | undefined): { context?: "vowel" } =>
  code && /^[AEIOU]/i.test(code) ? { context: "vowel" } : {};
