-- Area 11, F5: il tipo di un'iscrizione ammette il trattino basso nel PRIMO
-- segmento (`product_doc.updated`, `product_doc.question`). La regola della
-- 0177 (`^[a-z]+(\.[a-z_]+)+$`) lo vietava: nessuna iscrizione della doc di
-- prodotto si poteva scrivere, e le Preferenze non potevano accendere né
-- spegnere quelle righe. Le righe che ci sono già passano anche la regola nuova
-- (è più larga).
ALTER TABLE "alert_subscriptions" DROP CONSTRAINT "alert_subscriptions_type_chk";
--> statement-breakpoint
ALTER TABLE "alert_subscriptions" ADD CONSTRAINT "alert_subscriptions_type_chk" CHECK ("alert_type" ~ '^[a-z][a-z_]*(\.[a-z_]+)+$');
