-- Area 10, F1 (review I2): la conversazione con Claude ha letto contenuto
-- PERSONALE di chi la possiede — la sua posta, il suo calendario, un canale
-- privato o un DM, un'automazione generale. Da lì non si pubblica più:
-- `mailbox_owner` non include MAI gli admin, e una pubblica la leggerebbe chi
-- ha `claude.public.view`. Lo scrive la lettura riuscita del token del turno
-- (`recordChatToolPrivateRead`), come `untrusted_read_at`.
ALTER TABLE "claude_conversations" ADD COLUMN "private_read_at" timestamp with time zone;
