/**
 * AVVIO DEL RELAY.
 *
 * Tutto ciò che può essere sbagliato nella configurazione fa fallire QUI, prima
 * che il servizio accetti una richiesta: un relay che parte a metà fallirebbe le
 * push una a una, in silenzio, sembrando vivo (vedi `./config.ts`).
 */
import { createApnsClient } from "./apns.js";
import { loadRelayConfig } from "./config.js";
import { createFcmClient } from "./fcm.js";
import { buildRelay } from "./server.js";

const config = loadRelayConfig(process.env);

const apns =
  config.apns !== null
    ? createApnsClient({
        keyP8: config.apns.keyP8,
        keyId: config.apns.keyId,
        teamId: config.apns.teamId,
        bundleId: config.apns.bundleId,
        sandbox: config.apns.sandbox,
      })
    : null;

const app = buildRelay({
  config,
  apns,
  fcm: createFcmClient({ serviceAccountJson: config.fcm.serviceAccountJson }),
});

/**
 * ⚠️ La riga d'avvio DICE l'ambiente APNs, e non è decorazione.
 *
 * `APNS_SANDBOX` invertito è un guasto che il relay non può accorgersi di avere:
 * Apple risponde `BadDeviceToken` sia per un token inventato sia per un token
 * giusto mandato all'ambiente sbagliato, quindi a valle i due casi sono
 * indistinguibili. Questa riga è l'ULTIMO punto in cui un umano può vedere la
 * differenza — per questo l'ambiente si stampa anche quando il client APNs è
 * spento, dove serve a ricordare che i token iOS stanno passando da Firebase.
 *
 * Il `project_id` di FCM si stampa perché è pubblico e identifica l'istanza
 * Firebase; nessun altro pezzo delle credenziali finisce nel log.
 */
app.log.info(
  {
    iosPushVia: config.iosPushVia,
    apnsEnvironment:
      config.apns === null
        ? "n/d (client APNs spento)"
        : config.apns.sandbox
          ? "sandbox"
          : "production",
    fcmProjectId: config.fcm.projectId,
    rate: config.rate,
  },
  "push relay in avvio",
);

// `0.0.0.0`: dentro il compose il servizio è raggiungibile solo dalla rete
// interna (nessuna porta pubblicata), ed è Caddy a esporlo sul sottodominio.
await app.listen({ port: config.port, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => {
      apns?.close();
      process.exit(0);
    });
  });
}
