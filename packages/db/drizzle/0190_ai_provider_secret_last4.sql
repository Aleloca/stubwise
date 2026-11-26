-- Area 9, F3, Task 8c: le ultime 4 cifre della credenziale di un provider AI,
-- scritte quando la credenziale si crea o si sostituisce (la vista le mostra:
-- «•••• 9e2b»). Le righe di prima restano NULL finché non la si sostituisce:
-- il server non decifra per ricavarle.
ALTER TABLE "ai_providers" ADD COLUMN "secret_last4" text;
