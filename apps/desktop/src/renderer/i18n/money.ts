// I dollari dell'app, in un formato solo (Impeccable 7): «$» davanti e i
// separatori della lingua di chi guarda — «$410,05» in italiano, «$1,234.50»
// in inglese. Lo usano Usage, Budget, il registro delle modifiche e i
// consumi AI della task: mai «1,39 USD» accanto a «$410,05».

/**
 * `always`: sempre due decimali (importi spesi, consumi). `auto`: un intero
 * senza decimali, gli altri con due (budget, tetti, tacche di un asse).
 */
export function usd(n: number, language: string, cents: "always" | "auto" = "auto"): string {
  const digits = cents === "always" || !Number.isInteger(n) ? 2 : 0;
  const number = new Intl.NumberFormat(language, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
  return `$${number}`;
}
