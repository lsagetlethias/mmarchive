declare const __MMARCHIVE_VERSION__: string | undefined;

/**
 * Version de l outil, injectee au build depuis package.json. La valeur de repli
 * ne sert qu en execution directe par tsx, ou aucun define n a lieu.
 */
export const TOOL_VERSION: string =
  typeof __MMARCHIVE_VERSION__ === "string" ? __MMARCHIVE_VERSION__ : "0.0.0-dev";
