-- Area 4, Chat, fetta 2: la card di una domanda rivolta a un membro del
-- canale. Da sola: un valore d'enum non si usa nella transazione che lo
-- aggiunge (il batch di migrazioni è UNA transazione).
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'chat.question';
