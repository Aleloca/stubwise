-- Area 4, Chat, fetta 1: la card d'inbox di una menzione diretta. DA SOLO in
-- un file a sé (il batch gira in UNA transazione, e un valore enum aggiunto
-- non si usa nella stessa): lo scrive il server, dopo il commit.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'chat.mention';
