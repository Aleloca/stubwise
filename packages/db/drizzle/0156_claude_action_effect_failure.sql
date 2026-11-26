-- Area 6, F3: l'esito di un seguito dopo il commit che non è riuscito (fillMailBody).
ALTER TABLE "claude_actions" ADD COLUMN "effect_failure" text;
