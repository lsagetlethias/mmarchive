import { describe, expect, it } from "vitest";
import { parseServerVersion } from "../src/mattermost/http-client.js";

describe("parseServerVersion", () => {
  it("extrait la version publiee d un header reel", () => {
    // Valeur relevee sur un serveur en production.
    expect(parseServerVersion("10.12.4.19423977602.e5239d09275ad2a214c812215220c92b.false")).toBe(
      "10.12.4",
    );
  });

  it("accepte une version deja propre", () => {
    expect(parseServerVersion("9.5.2")).toBe("9.5.2");
  });

  it("ignore le numero de build et le hash", () => {
    expect(parseServerVersion("7.8.1.123456.abcdef.true")).toBe("7.8.1");
  });

  it("retombe sur la valeur brute quand la forme est inattendue", () => {
    // Mieux vaut un manifeste avec une valeur etrange qu un manifeste muet :
    // ce header n est pas contractuel et peut changer de forme.
    expect(parseServerVersion("edge-build")).toBe("edge-build");
    expect(parseServerVersion("10.12")).toBe("10.12");
  });

  it("renvoie undefined sur une valeur vide", () => {
    expect(parseServerVersion("")).toBeUndefined();
  });
});
