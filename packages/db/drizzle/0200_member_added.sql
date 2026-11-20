-- Area 10, F5 (D-11 = b, maintainer): «member.added», una persona entra in un
-- progetto. In uno statement a sé, e il valore non si usa in nessun'altra
-- migrazione dello stesso batch (CLAUDE.md, «Migrazioni Drizzle»).
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'member.added';
