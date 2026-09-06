# `caddy.d/` — blocchi di sito aggiuntivi

Questa cartella è montata read-only dentro il container `caddy` come
`/etc/caddy/conf.d`, e il `Caddyfile` la importa con un glob:

```
import /etc/caddy/conf.d/*.caddy
```

**Per le istanze self-hosted qui non c'è niente da fare.** La cartella contiene
solo file `.example`, che il glob non matcha: la configurazione di Caddy resta
identica a com'era, senza siti né listener in più.

## Perché un glob e non una variabile d'ambiente

Perché in Caddy **non esiste una sintassi condizionale per un indirizzo di
sito**, e le alternative che sembrano equivalenti non lo sono. Verificato con
`caddy validate` su `caddy:2-alpine`:

| forma | variabile assente | esito |
|---|---|---|
| `push.{$PUSH_RELAY_HOST} { … }` nel Caddyfile | l'indirizzo diventa `push.` | **exit 1, tutta la config rifiutata** — si romperebbe il sito di ogni istanza |
| `push.{$PUSH_RELAY_HOST:localhost} { … }` | sito `push.localhost` | valido, ma aggiunge un listener `:443` a chi ha `DOMAIN=:80` |
| `import Caddyfile.relay` (letterale) | file assente | **exit 1**, «File to import not found» |
| `import /etc/caddy/conf.d/*.caddy` | nessun match | **exit 0**, nessun sito in più — anche se la cartella non esiste |

## Attivare il relay push (solo sul nostro VPS)

```sh
cp caddy.d/relay.caddy.example caddy.d/relay.caddy
# in .env: PUSH_RELAY_HOST=stubwise.thecove.it  (+ le chiavi APNs/FCM)
docker compose --profile relay up -d --build push-relay caddy
```

Da quel momento `PUSH_RELAY_HOST` è obbligatoria: senza, Caddy non parte
(rumorosamente — vedi la tabella). I file `*.caddy` copiati qui **non** sono
tracciati da git: sono configurazione dell'host, non del repo.
