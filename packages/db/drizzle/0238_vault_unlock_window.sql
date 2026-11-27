-- Indurimento di sicurezza (I6, nota della cassaforte nel browser §2.7): lo
-- sblocco della cassaforte con una passkey (`purpose: "vault"`) NON rinnova più
-- `second_factor_at`, che apre per 10 minuti OGNI rotta con la riconferma
-- (registrare una passkey, creare un PAT, le azioni C di Claude…). Ha la sua
-- finestra, valida solo per le rotte della cassaforte che la dichiarano
-- (`config.reauth: "vault"`). Null = nessuno sblocco in questa sessione.
ALTER TABLE "sessions" ADD COLUMN "vault_unlocked_at" timestamp with time zone;
