import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Una cartella temporanea per job (area 5, fetta 3), tolta SEMPRE nel
 * `finally`: su successo, su timeout, su un crash del figlio, su un'eccezione
 * nostra. Il nome viene dall'id del job ripulito, mai dal nome del file.
 */
export async function withJobTmp<T>(jobId: string, fn: (dir: string) => Promise<T>, root = tmpdir()): Promise<T> {
  const safe = jobId.replace(/[^0-9a-zA-Z-]/g, "").slice(0, 64) || "job";
  const dir = await mkdtemp(join(root, `stubwise-drive-${safe}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
