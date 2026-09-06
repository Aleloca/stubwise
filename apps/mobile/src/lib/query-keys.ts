/**
 * Chiavi di query dell'inbox — estratte da `inbox-mutations.ts` in un modulo
 * proprio perché il Task 19 le usa anche in `app/providers.tsx` (refresh al
 * foreground + badge OS), e `providers.tsx` NON può importare
 * `inbox-mutations.ts` direttamente: quel file importa `useAuth` DA
 * `app/providers`, quindi l'import inverso chiuderebbe un ciclo fra i due
 * moduli. Un modulo terzo, senza dipendenze, rompe il ciclo.
 *
 * `inbox-mutations.ts` ri-esporta `inboxKeys` da qui: nessun chiamante
 * esistente (`InboxScreen`, `InboxCardScreen`, `ProjectDetailScreen`, i test)
 * deve cambiare il proprio import.
 *
 * SENZA filtri, a differenza di `inboxKeys` in `apps/web/src/lib/queries.ts`:
 * l'app mobile legge sempre l'inbox APERTA per intero (nessuna vista per
 * progetto/stato in questo task).
 */
export const inboxKeys = {
  all: ["inbox"] as const,
  list: () => [...inboxKeys.all, "list"] as const,
  unread: () => [...inboxKeys.all, "unread"] as const,
};
