-- Area 9, F3, Task 7: la FONTE del modello di ogni operazione
-- (`GET /api/settings/models` → `source: setting | env | default`).
-- `worker_model_defaults` fonde l'env del worker e il default di codice:
-- qui il worker scrive all'avvio le operazioni il cui modello viene da una
-- variabile d'ambiente impostata. Nullable: un worker di prima la lascia
-- nulla, e allora la fonte risulta `default` finché non si riavvia.
ALTER TABLE "instance_settings" ADD COLUMN "worker_model_env_operations" text[];
