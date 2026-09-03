/**
 * Dichiarazione MINIMA e volutamente stretta di `process.env.JEST_WORKER_ID`.
 *
 * Il tsconfig di `@react-native/typescript-config` fissa `"types": ["jest"]`
 * apposta — per non far collidere i globali di Node con quelli di React
 * Native (commento nel preset: "Causes issues with package.json exports").
 * Aggiungere `@types/node` per intero riaprirebbe esattamente quel
 * problema per un solo valore che ci serve (vedi `components/Wordmark.tsx`,
 * che spegne il blink infinito sotto Jest). Questa dichiarazione locale
 * copre SOLO quel valore, senza toccare `lib`/`types` del preset.
 */
declare const process: {
  env?: {
    JEST_WORKER_ID?: string;
  };
};
