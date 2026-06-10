export * from "./schema.js";
export { createDb, runMigrations, type Db, type DbHandle } from "./client.js";
// Cifratura delle credenziali a riposo: vive qui (non nel server) perché è
// accoppiata a ciò che è salvato nel DB (projects.encryptedCredentials) e
// serve sia al server (encrypt alla creazione) sia al worker (decrypt nel fix).
export { decrypt, encrypt } from "./secrets.js";
