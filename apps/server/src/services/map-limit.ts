/**
 * `Promise.all` con un tetto: al più `limit` chiamate di `fn` in volo, i
 * risultati nell'ordine dell'input. Serve dove si fa una query per progetto
 * (il portafoglio dell'Overview, fetta 4): con decine di progetti un
 * `Promise.all` nudo occupa il pool del DB per tutti gli altri.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
