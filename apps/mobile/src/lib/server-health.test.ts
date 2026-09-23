import { UNKNOWN } from "@stubwise/shared";
import { formatBytes, memoryReading, sampleAge, serverIsBroken, serverStatusKey, usedPct } from "./server-health";

const NOW = Date.parse("2026-09-23T10:00:00.000Z");

describe("sampleAge", () => {
  test("nessun campione: none, non un campione vecchio", () => {
    expect(sampleAge(null, 30, NOW)).toEqual({ kind: "none" });
  });

  test("entro 2× l'intervallo è fresco", () => {
    expect(sampleAge("2026-09-23T09:59:00.000Z", 30, NOW).kind).toBe("fresh");
  });

  /**
   * La soglia è quella del WEB (2×), non quella di `offline` (3×): a 90 s su
   * un intervallo di 30 s il server è ancora `online`, ma i numeri sono già
   * vecchi e la schermata lo deve dire.
   */
  test("oltre 2× l'intervallo è vecchio, anche se il server non è ancora offline", () => {
    expect(sampleAge("2026-09-23T09:58:30.000Z", 30, NOW).kind).toBe("stale");
  });
});

describe("formatBytes", () => {
  test("base 1024, un decimale senza zeri di troppo", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 ** 3)).toBe("2 GB");
    expect(formatBytes(1.5 * 1024 ** 4)).toBe("1.5 TB");
  });
});

describe("usedPct", () => {
  test("percentuale intera", () => {
    expect(usedPct(40, 100)).toBe(40);
  });
  test("totale zero: non calcolabile, non 0%", () => {
    expect(usedPct(0, 0)).toBeNull();
  });
});

describe("memoryReading", () => {
  test("mai connesso: niente da mostrare", () => {
    expect(memoryReading({ metricsAt: null, memUsedBytes: null, memTotalBytes: null })).toEqual({ kind: "never" });
  });

  /**
   * ⚠️ Il caso che questa funzione esiste per distinguere: campioni ci sono,
   * la memoria no — è un server più vecchio di questa app. «0 GB» qui sarebbe
   * un numero falso.
   */
  test("server che non manda la memoria: non disponibile, mai 0", () => {
    expect(
      memoryReading({ metricsAt: "2026-09-23T09:59:00.000Z", memUsedBytes: null, memTotalBytes: null }),
    ).toEqual({ kind: "unavailable" });
  });

  test("i due numeri, con la percentuale", () => {
    expect(
      memoryReading({ metricsAt: "2026-09-23T09:59:00.000Z", memUsedBytes: 3 * 1024 ** 3, memTotalBytes: 4 * 1024 ** 3 }),
    ).toEqual({ kind: "known", usedBytes: 3 * 1024 ** 3, totalBytes: 4 * 1024 ** 3, pct: 75 });
  });
});

describe("serverIsBroken", () => {
  test("offline è rotto", () => {
    expect(serverIsBroken({ status: "offline", checksDown: 0 })).toBe(true);
  });
  test("online con un controllo giù è rotto", () => {
    expect(serverIsBroken({ status: "online", checksDown: 1 })).toBe(true);
  });
  test("mai connesso non è un guasto: è un server appena registrato", () => {
    expect(serverIsBroken({ status: "never_connected", checksDown: 0 })).toBe(false);
  });
  test("online e tutto su: niente rosso", () => {
    expect(serverIsBroken({ status: "online", checksDown: 0 })).toBe(false);
  });
});

describe("serverStatusKey", () => {
  test("uno stato sconosciuto non diventa online", () => {
    expect(serverStatusKey(UNKNOWN)).toBe("mobile.projects.monitor.status.unknown");
  });
});
