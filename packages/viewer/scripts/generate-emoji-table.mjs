import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Genere la seule table de donnees. La logique de resolution vit dans emoji.ts,
 * ecrite a la main : melanger les deux obligeait a echapper les interpolations
 * du code produit dans celles du generateur.
 */
const require = createRequire(new URL("../", import.meta.url));
const { nameToEmoji } = require("gemoji");

const entries = Object.entries(nameToEmoji).sort(([a], [b]) => (a < b ? -1 : 1));
const lines = entries.map(
  ([name, emoji]) => `  ${JSON.stringify(name)}: ${JSON.stringify(emoji)},`,
);

const header = [
  "/**",
  " * Correspondance entre les raccourcis d emoji et leur caractere.",
  " *",
  " * Table generee depuis gemoji : l archive doit pouvoir etre consultee sur un",
  " * reseau ferme, aucun service tiers ne peut etre interroge a l affichage. Les",
  " * emojis personnalises, eux, viennent de l archive et sont servis en image.",
  " *",
  " * Ne pas editer a la main : regenerer avec scripts/generate-emoji-table.mjs.",
  " */",
  "export const EMOJI_BY_NAME: Readonly<Record<string, string>> = {",
];

const out = `${header.join("\n")}\n${lines.join("\n")}\n};\n`;
const target = fileURLToPath(new URL("../web/src/ui/emoji-table.ts", import.meta.url));
writeFileSync(target, out);
process.stdout.write(`${entries.length} raccourcis ecrits dans ${target}\n`);
