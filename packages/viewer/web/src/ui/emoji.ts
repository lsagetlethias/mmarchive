import { EMOJI_BY_NAME } from "./emoji-table.js";

/** Modificateurs de teinte, que Mattermost accole au nom du raccourci. */
const SKIN_TONES: Readonly<Record<string, string>> = {
  light_skin_tone: "\u{1F3FB}",
  medium_light_skin_tone: "\u{1F3FC}",
  medium_skin_tone: "\u{1F3FD}",
  medium_dark_skin_tone: "\u{1F3FE}",
  dark_skin_tone: "\u{1F3FF}",
};

/**
 * Raccourcis que Mattermost nomme autrement que la table de reference. Releves
 * sur une archive reelle, par frequence decroissante : ce sont ceux qui
 * restaient non resolus une fois les regles d ecriture appliquees.
 */
const ALIASES: Readonly<Record<string, string>> = {
  rolling_on_the_floor_laughing: "rofl",
  smiling_face_with_3_hearts: "smiling_face_with_three_hearts",
  hugging_face: "hugs",
  the_horns: "metal",
  face_with_rolling_eyes: "roll_eyes",
};

/**
 * Variantes d ecriture d un meme raccourci. Mattermost separe indifferemment
 * par tiret ou par soulignement, prefixe certains noms par "face_with_" et en
 * suffixe d autres par "_face", la ou la table de reference ne le fait pas.
 */
function* candidates(name: string): Generator<string> {
  yield name;
  const alias = ALIASES[name];
  if (alias !== undefined) yield alias;
  yield name.replace(/-/g, "_");
  yield name.replace(/_/g, "-");
  yield name.replace(/_face$/, "");
  yield name.replace(/^face_with_/, "");
  const gendered = /^(man|woman)-(.+)$/.exec(name);
  if (gendered !== null) {
    yield `${gendered[2] ?? ""}_${gendered[1] ?? ""}`;
    yield `${gendered[1] ?? ""}_${gendered[2] ?? ""}`;
  }
}

/**
 * Resout un raccourci, ses variantes d ecriture et sa teinte.
 *
 * Rend undefined pour un raccourci inconnu, que l affichage laisse alors tel
 * quel : mieux vaut lire ":truc:" que voir l information disparaitre derriere
 * un caractere de remplacement.
 */
export function standardEmoji(name: string): string | undefined {
  for (const candidate of candidates(name)) {
    const found = EMOJI_BY_NAME[candidate];
    if (found !== undefined) return found;
  }
  for (const [suffix, modifier] of Object.entries(SKIN_TONES)) {
    if (!name.endsWith(`_${suffix}`)) continue;
    const base = standardEmoji(name.slice(0, -suffix.length - 1));
    if (base !== undefined) return base + modifier;
  }
  return undefined;
}
