// Una foglia: `s3.ts` e `index.ts` la importano entrambi senza un giro.

/**
 * L'oggetto da leggere o copiare non c'è (S3 `NoSuchKey`): per esempio un
 * allegato della Chat tolto mentre qualcuno lo salva nel Drive. Chi chiama lo
 * tratta come un 404, non come un guasto dello storage.
 */
export class StorageObjectNotFound extends Error {
  constructor(readonly key: string) {
    super(`Object not found: ${key}`);
    this.name = "StorageObjectNotFound";
  }
}
