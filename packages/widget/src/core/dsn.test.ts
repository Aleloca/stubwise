import { describe, expect, it } from "vitest";
import { parseWidgetDsn } from "./dsn.js";

describe("parseWidgetDsn", () => {
  it("estrae origin, slug e key da un DSN valido", () => {
    expect(parseWidgetDsn("https://KEY@example.com/p/acme")).toEqual({
      origin: "https://example.com",
      slug: "acme",
      key: "KEY",
    });
  });

  it("preserva la porta", () => {
    expect(parseWidgetDsn("https://KEY@example.com:8443/p/acme")).toEqual({
      origin: "https://example.com:8443",
      slug: "acme",
      key: "KEY",
    });
  });

  it("preserva un prefisso di path", () => {
    expect(parseWidgetDsn("https://KEY@example.com/stubwise/p/acme")).toEqual({
      origin: "https://example.com/stubwise",
      slug: "acme",
      key: "KEY",
    });
  });

  it("accetta http (dev locale) e una porta", () => {
    expect(parseWidgetDsn("http://KEY@localhost:3000/p/acme")).toEqual({
      origin: "http://localhost:3000",
      slug: "acme",
      key: "KEY",
    });
  });

  it("decodifica una key url-encoded", () => {
    expect(parseWidgetDsn("https://a%2Fb@example.com/p/acme").key).toBe("a/b");
  });

  it("tollera lo slash finale", () => {
    expect(parseWidgetDsn("https://KEY@example.com/p/acme/").slug).toBe("acme");
  });

  it("lancia su DSN non-URL", () => {
    expect(() => parseWidgetDsn("non-un-url")).toThrow();
  });

  it("lancia su protocollo non http(s)", () => {
    expect(() => parseWidgetDsn("ftp://KEY@example.com/p/acme")).toThrow();
  });

  it("lancia se la key è mancante", () => {
    expect(() => parseWidgetDsn("https://example.com/p/acme")).toThrow();
  });

  it("lancia se lo slug/path non corrisponde a /p/<slug>", () => {
    expect(() => parseWidgetDsn("https://KEY@example.com/acme")).toThrow();
    expect(() => parseWidgetDsn("https://KEY@example.com/p/")).toThrow();
  });
});
