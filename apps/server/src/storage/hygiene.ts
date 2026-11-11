/**
 * La pulizia oraria dello storage (gli allegati della Chat in sospeso, gli
 * oggetti del Drive da togliere): ogni passo nel SUO try, così uno che fallisce
 * non salta i successivi (review della fetta 2). Fail-open: chi fallisce
 * riprova al giro dopo.
 */
export async function runStorageHygiene(
  steps: ReadonlyArray<{ name: string; run: () => Promise<unknown> }>,
  log: (error: unknown, name: string) => void,
): Promise<void> {
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      log(error, step.name);
    }
  }
}
