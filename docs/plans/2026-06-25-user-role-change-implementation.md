# Cambio ruolo utente — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Permettere agli admin di cambiare il ruolo (`admin`/`member`) di un altro
utente dalla pagina Team, con i safeguard: non si declassa l'ultimo admin, non si
cambia il proprio ruolo.

**Tech Stack:** Fastify+Zod, Drizzle, React+TanStack, Vitest. Tutto server+web,
niente migrazioni (la colonna `users.role` esiste già).

---

## Task 1: Endpoint `PATCH /api/users/:id/role` (server)

**Files:** `apps/server/src/routes/users.ts`; test `apps/server/src/routes/users.test.ts` (se non esiste, crealo col pattern testcontainers degli altri test route).

Studia: `users.ts` (route `GET /`, `publicUserSchema`, `userRoutes`), `requireAdmin`
in `apps/server/src/auth/session.ts`, e `request.user` (id + role) popolato da requireAuth.
Pattern delle altre route con `:id` e `requireAdmin` (es. `slack/identity-routes.ts`
PUT `/users/:id/slack`, o le route progetti): apiError, schemi Zod params/body/response.

**Aggiungi** in `userRoutes`:
```ts
app.patch("/:id/role", {
  preHandler: requireAdmin,
  schema: {
    params: z.object({ id: z.uuid() }),
    body: z.object({ role: z.enum(["admin", "member"]) }),
    response: { 200: publicUserSchema, 400: errorSchema, 404: errorSchema, 409: errorSchema, ...authErrorResponses },
  },
}, async (request, reply) => { ... })
```
Logica:
1. `const { id } = request.params; const { role } = request.body;`
2. **Self-check**: se `id === request.user!.id` → `apiError(reply, 400, "cannot_change_own_role", "You cannot change your own role")`.
3. Carica l'utente target (`select id, role, email, createdAt, slackAvatarUrl, slackUserId from users where id`). Se assente → 404 `user_not_found`.
4. **Ultimo admin**: se il target è `admin` e il nuovo `role` è `member`, conta gli admin (`select count(*) where role='admin'`). Se `count <= 1` → `apiError(reply, 409, "last_admin", "Cannot demote the last admin")`.
5. No-op se `target.role === role` → ritorna comunque l'utente (idempotente). (Oppure aggiorna comunque; entrambe ok.)
6. `update users set role=role where id=id`. Ritorna l'utente aggiornato nel formato `publicUserSchema` (riusa il mapping di `GET /`: id/email/role/createdAt(ISO)/avatarUrl/slackUserId).

Importa `errorSchema`/`apiError`/`eq`/`and`/`sql`/`count` come servono (guarda gli altri file route).

**Test** (testcontainers, seed di più utenti con ruoli):
- admin promuove un member → 200, ruolo aggiornato (verifica via GET o nel body).
- admin declassa un altro admin (con ≥2 admin) → 200.
- declassare l'ULTIMO admin → 409 `last_admin`.
- admin cambia il PROPRIO ruolo → 400 `cannot_change_own_role`.
- id inesistente → 404.
- utente NON admin (member) chiama l'endpoint → 403 (requireAdmin).
- non autenticato → 401.

**Verifiche:** `pnpm --filter @stubwise/server typecheck && test users && pnpm lint`.
**Commit:** `feat(server): PATCH /users/:id/role per il cambio ruolo (admin-only, safeguard)`.

---

## Task 2: UI nella pagina Team (web)

**Files:** `apps/web/src/lib/api.ts` (+ `queries.ts` se serve); `apps/web/src/routes/team.tsx`;
i18n `apps/web/src/i18n/locales/{it,en}.json`; test `team.test.tsx`.

Studia: `team.tsx` — `MembersSection({ currentUserId, isAdmin })` → `MemberRow({ user, isCurrentUser, isAdmin, ... })`, il `RoleBadge`, e il pattern delle mutation slack (`linkMutation`/`unlinkMutation` con invalidate di `usersQueryOptions`). `api.ts` — `TeamUser`, `getUsers`, `linkUserSlack` (PUT pattern), `usersQueryOptions`.

**Step 1 — client API.**
```ts
export function updateUserRole(userId: string, role: "admin" | "member"): Promise<TeamUser> {
  return api.patch(`/api/users/${encodeURIComponent(userId)}/role`, { role });
}
```
(Se `api.patch` non esiste, usa `request("PATCH", ...)` come fa `unlinkUserSlack` con DELETE.)

**Step 2 — `MemberRow`.** Per un admin che guarda un utente **diverso da sé** (`isAdmin && !isCurrentUser`), aggiungi un controllo per cambiare ruolo: un piccolo `<select>` con "Admin"/"Member" (valore = `user.role`) che, on change, chiama una `roleMutation` (`useMutation({ mutationFn: (role) => updateUserRole(user.id, role), onSuccess: invalidate usersQueryOptions })`). Mostra un errore leggibile se la mutation fallisce (es. `last_admin` → "Non puoi declassare l'ultimo admin", `cannot_change_own_role` → non dovrebbe capitare perché il controllo non compare per sé). Per l'utente corrente e per i non-admin resta SOLO il `RoleBadge` (read-only), come ora.
- Mappa i codici d'errore del server a messaggi i18n (riusa il pattern di gestione errori già presente, es. come si mostra l'errore di altre mutation; se non c'è, un piccolo testo sotto il select).

**Step 3 — i18n.** Chiavi sotto `settings.team` (parità it/en): es. `changeRole`, `roleAdmin`, `roleMember`, e i messaggi d'errore `errorLastAdmin`, `errorOwnRole`.

**Step 4 — test** (`team.test.tsx`, riusa il setup/mock di rete esistente): admin vede il selettore di ruolo per gli altri utenti, NON per sé (sé → solo badge); cambiando il valore parte la PATCH col ruolo giusto; un member NON vede il selettore (solo badge). Se semplice, un caso d'errore `last_admin` che mostra il messaggio.

**Verifiche:** `pnpm --filter @stubwise/web typecheck && test team && pnpm lint`.
**Commit:** `feat(web): cambio ruolo utente nella pagina Team (admin-only)`.

---

## Task 3: Verifica finale + deploy

**Step 1.** `pnpm typecheck && pnpm lint`, poi `pnpm --filter @stubwise/server test` e `pnpm --filter @stubwise/web test`.
**Step 2.** REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch (merge su main).
**Step 3.** Deploy: `server` (endpoint) + `caddy` (UI). Niente migrazioni. Verifica health + bundle.

---

## Note

- Safeguard server-side AUTORITATIVI (l'UI è solo comodità): self-role e last-admin
  vanno verificati nell'endpoint, non solo nascondendo il controllo in UI.
- Niente migrazioni: `users.role` esiste già (enum admin/member).
- YAGNI: solo admin/member (no ruoli nuovi), nessuna gestione per-progetto.
