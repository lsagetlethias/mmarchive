import { describe, expect, it } from "vitest";
import { ExportFlagError, parseExportFlag } from "../src/server/export-flag.js";

describe("parseExportFlag", () => {
  it("laisse l export desactive sans variable", () => {
    expect(parseExportFlag(undefined)).toBe(false);
  });

  it.each(["1", "true", "TRUE", " true "])("active sur %j", (raw) => {
    expect(parseExportFlag(raw)).toBe(true);
  });

  it.each(["", "0", "false", "False"])("desactive sur %j", (raw) => {
    expect(parseExportFlag(raw)).toBe(false);
  });

  it.each(["oui", "yes", "2", "on"])("refuse %j plutot que de deviner", (raw) => {
    expect(() => parseExportFlag(raw)).toThrow(ExportFlagError);
  });
});
