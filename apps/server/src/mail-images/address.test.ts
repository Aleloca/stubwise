import { describe, expect, it } from "vitest";
import { checkImageUrl, isBlockedAddress } from "./address.js";

// Le immagini delle email passano dal nostro server (design
// `docs/plans/2026-11-28-proxy-immagini-posta-design.md`, §3): l'URL e gli
// indirizzi che il proxy non chiede MAI.

describe("isBlockedAddress", () => {
  it.each([
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fc00::1", "fd00:ec2::254", "fe80::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "64:ff9b::10.0.0.1",
    // Revisione M3: fuori dall'unicast globale (2000::/3) o casi speciali dentro.
    "::7f00:1", "::ffff:0:7f00:1", "64:ff9b:1::1", "2002:7f00:1::1", "2001::1", "2001:0:4136:e378::1", "fec0::1", "100::1",
    "3fff::1", "168.63.129.16",
  ])("%s è vietato", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"])("%s è ammesso", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it("una stringa che non è un IP è vietata (mai un'ammissione per errore)", () => {
    expect(isBlockedAddress("example.com")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("checkImageUrl: schema, porta, credenziali e host normalizzato", () => {
  it("un https pubblico passa, col nome normalizzato (IDN in punycode, minuscolo)", () => {
    expect(checkImageUrl("https://Example.com/a.png?x=1")).toEqual({ ok: true, url: new URL("https://example.com/a.png?x=1"), host: "example.com", literal: null });
    expect(checkImageUrl("https://bücher.example/a.png")).toMatchObject({ ok: true, host: "xn--bcher-kva.example" });
    expect(checkImageUrl("https://example.com:443/a.png")).toMatchObject({ ok: true });
  });

  it.each([
    ["http://example.com/a.png", "scheme"],
    ["ftp://example.com/a.png", "scheme"],
    ["https://example.com:8443/a.png", "port"],
    ["https://user:pass@example.com/a.png", "credentials"],
    ["https://user@example.com/a.png", "credentials"],
    ["https://localhost/a.png", "host"],
    ["https://localhost./a.png", "host"],
    ["https://app.localhost/a.png", "host"],
    ["https://printer.local/a.png", "host"],
    ["https://metadata.google.internal/a.png", "host"],
    ["non è un url", "invalid"],
  ])("%s → %s", (url, reason) => {
    expect(checkImageUrl(url)).toEqual({ ok: false, reason });
  });

  it.each([
    "https://127.0.0.1/a.png",
    "https://2130706433/a.png",
    "https://0177.0.0.1/a.png",
    "https://0x7f.0.0.1/a.png",
    "https://0x7f000001/a.png",
    "https://127.1/a.png",
    "https://[::1]/a.png",
    "https://[::ffff:127.0.0.1]/a.png",
    "https://[::ffff:7f00:1]/a.png",
    "https://169.254.169.254/latest/meta-data",
    "https://[fd00:ec2::254]/",
  ])("%s: un IP letterale vietato, in qualunque scrittura", (url) => {
    expect(checkImageUrl(url)).toEqual({ ok: false, reason: "address" });
  });

  it("un IP letterale pubblico passa, ed è già quello a cui connettersi", () => {
    expect(checkImageUrl("https://8.8.8.8/a.png")).toMatchObject({ ok: true, literal: "8.8.8.8" });
    expect(checkImageUrl("https://[2606:4700::1111]/a.png")).toMatchObject({ ok: true, literal: "2606:4700::1111" });
  });
});
