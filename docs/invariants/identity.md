# Invarianti e trappole — L'identità della persona: email di login e foto (16 nov 2026)

> Design: `docs/plans/2026-11-16-integrazione-area9-design.md` (F1, §1.6,
> D-13 = b ed E-1 = a del maintainer). Le regole del secondo fattore e della
> riconferma stanno in `second-factor.md`.

- **L'email di login cambia solo dopo il clic sul link mandato alla NUOVA.**
  La richiesta vuole la riconferma; il link vale 24 ore, è monouso e salvato
  come hash; fino al clic la vecchia resta quella del login. Il cambio,
  nella stessa transazione, scrive `security_events` (`email_changed`) e la
  voce del registro, e manda `security.alert`. Sessioni, token e secondo
  fattore restano intatti; le caselle Google e le identità git e Slack non
  cambiano. Un indirizzo già di un'altra persona o di un invito pendente è
  rifiutato con lo stesso errore.
- **La foto è un'immagine, mai un documento.** PNG, JPEG o WebP DEDOTTI dai
  magic bytes (il tipo dichiarato non conta), al più 512 KB, mai SVG né GIF;
  servita col tipo dedotto, `nosniff`, una CSP `default-src 'none';
  sandbox` e la stessa visibilità delle persone.
