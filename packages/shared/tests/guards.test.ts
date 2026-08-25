import { describe, expect, it } from "vitest";
import {
  assertPublicChannel,
  isArchivedChannel,
  isChannelType,
  isDeactivatedUser,
  isMattermostId,
  isPublicChannel,
  NonPublicChannelError,
} from "../src/guards.js";

const NON_PUBLIC_TYPES = ["P", "D", "G"] as const;

describe("isPublicChannel", () => {
  it("accepte le type O", () => {
    expect(isPublicChannel({ type: "O" })).toBe(true);
  });

  it.each(NON_PUBLIC_TYPES)("refuse le type %s", (type) => {
    expect(isPublicChannel({ type })).toBe(false);
  });

  it("refuse un type absent ou inconnu", () => {
    expect(isPublicChannel({})).toBe(false);
    expect(isPublicChannel({ type: undefined })).toBe(false);
    expect(isPublicChannel({ type: "" })).toBe(false);
    expect(isPublicChannel({ type: "o" })).toBe(false);
    expect(isPublicChannel({ type: "X" })).toBe(false);
  });
});

describe("assertPublicChannel", () => {
  it("laisse passer un canal public", () => {
    expect(() => {
      assertPublicChannel({ id: "a".repeat(26), type: "O" });
    }).not.toThrow();
  });

  it.each(NON_PUBLIC_TYPES)("leve une NonPublicChannelError pour le type %s", (type) => {
    expect(() => {
      assertPublicChannel({ id: "a".repeat(26), type });
    }).toThrow(NonPublicChannelError);
  });

  it("expose l id et le type refuses", () => {
    try {
      assertPublicChannel({ id: "b".repeat(26), type: "P" });
      expect.unreachable("aurait du lever");
    } catch (error) {
      expect(error).toBeInstanceOf(NonPublicChannelError);
      const typed = error as NonPublicChannelError;
      expect(typed.channelId).toBe("b".repeat(26));
      expect(typed.channelType).toBe("P");
    }
  });
});

describe("isArchivedChannel", () => {
  it("considere delete_at nul comme actif", () => {
    expect(isArchivedChannel({ delete_at: 0 })).toBe(false);
    expect(isArchivedChannel({})).toBe(false);
  });

  it("considere delete_at non nul comme archive", () => {
    expect(isArchivedChannel({ delete_at: 1718000000000 })).toBe(true);
  });
});

describe("isDeactivatedUser", () => {
  it("detecte un compte desactive", () => {
    expect(isDeactivatedUser({ delete_at: 1718000000000 })).toBe(true);
    expect(isDeactivatedUser({ delete_at: 0 })).toBe(false);
  });
});

describe("isMattermostId", () => {
  it("accepte un id de 26 caracteres alphanumeriques minuscules", () => {
    expect(isMattermostId("abcdefghij1234567890abcdef")).toBe(true);
  });

  it("refuse les longueurs et alphabets invalides", () => {
    expect(isMattermostId("trop-court")).toBe(false);
    expect(isMattermostId("A".repeat(26))).toBe(false);
    expect(isMattermostId("a".repeat(27))).toBe(false);
    expect(isMattermostId("")).toBe(false);
  });
});

describe("isChannelType", () => {
  it("reconnait les quatre types documentes", () => {
    expect(isChannelType("O")).toBe(true);
    expect(isChannelType("P")).toBe(true);
    expect(isChannelType("D")).toBe(true);
    expect(isChannelType("G")).toBe(true);
    expect(isChannelType("Z")).toBe(false);
  });
});
