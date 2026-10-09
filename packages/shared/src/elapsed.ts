/**
 * Da quanto gira una sessione, contato dal CLIENT a partire da `startedAt`:
 * il server manda la data e mai un numero, che in una risposta in cache
 * invecchierebbe. Mai negativo (orologi sfasati fra server e browser).
 */
export function elapsedParts(startedAt: string, now: number): { hours: number; minutes: number } {
  const ms = Math.max(0, now - Date.parse(startedAt));
  const totalMinutes = Math.floor(ms / 60_000);
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}
