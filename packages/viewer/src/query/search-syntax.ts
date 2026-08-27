import { normalizeHashtag, TAG_PREFIX } from "../index/schema.js";

/** Modificateurs reconnus, repris de la syntaxe de recherche Mattermost. */
export const SEARCH_MODIFIERS = ["from", "in", "before", "after", "on"] as const;

export type SearchModifier = (typeof SEARCH_MODIFIERS)[number];

export interface SearchTerm {
  readonly text: string;
  /** Ecrit entre guillemets : les mots doivent se suivre dans cet ordre. */
  readonly phrase: boolean;
  /** Suffixe par une etoile : correspond a tout mot commencant par ce texte. */
  readonly prefix: boolean;
}

export interface ParsedSearch {
  readonly include: readonly SearchTerm[];
  readonly exclude: readonly SearchTerm[];
  readonly from: readonly string[];
  readonly notFrom: readonly string[];
  readonly channels: readonly string[];
  readonly notChannels: readonly string[];
  readonly hashtags: readonly string[];
  readonly notHashtags: readonly string[];
  readonly before: string | undefined;
  readonly after: string | undefined;
  readonly on: string | undefined;
  /** Fragments écartés, pour pouvoir le dire plutot que de les ignorer en silence. */
  readonly ignored: readonly string[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Un terme qui ne contient ni lettre ni chiffre ne produit aucun token une fois
 * passe au tokenizer, et FTS5 le fait alors correspondre a zero ligne sans
 * lever d erreur. L ecarter ici evite qu une ponctuation isolee transforme
 * silencieusement une recherche valide en resultat vide.
 */
function hasSearchableContent(text: string): boolean {
  return /[\p{Letter}\p{Number}]/u.test(text);
}

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parts = value.split("-").map((part) => Number(part));
  const [year, month, day] = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

interface RawToken {
  readonly negated: boolean;
  readonly modifier: SearchModifier | undefined;
  readonly hashtag: boolean;
  readonly value: string;
  readonly quoted: boolean;
  readonly prefix: boolean;
}

function isModifier(value: string): value is SearchModifier {
  return (SEARCH_MODIFIERS as readonly string[]).includes(value);
}

/**
 * charAt plutot que l indexation : hors bornes il rend la chaine vide au lieu
 * d undefined, ce qui evite d avoir a garder une condition de longueur a chaque
 * comparaison.
 */
function scan(input: string): RawToken[] {
  const tokens: RawToken[] = [];
  let i = 0;

  while (i < input.length) {
    while (i < input.length && /\s/.test(input.charAt(i))) i += 1;
    if (i >= input.length) break;

    let negated = false;
    if (input.charAt(i) === "-") {
      negated = true;
      i += 1;
    }

    let modifier: SearchModifier | undefined;
    const match = /^([a-zA-Z]+):/.exec(input.slice(i));
    // Un mot contenant deux points sans etre un modificateur connu, comme une
    // URL, reste du texte ordinaire.
    if (match !== null) {
      const candidate = (match[1] ?? "").toLowerCase();
      if (isModifier(candidate)) {
        modifier = candidate;
        i += match[0].length;
      }
    }

    let hashtag = false;
    if (input.charAt(i) === "#") {
      hashtag = true;
      i += 1;
    }

    let value = "";
    let quoted = false;
    if (input.charAt(i) === '"') {
      quoted = true;
      i += 1;
      while (i < input.length && input.charAt(i) !== '"') {
        value += input.charAt(i);
        i += 1;
      }
      // Un guillemet ouvrant jamais referme : on prend jusqu a la fin plutot que
      // de rejeter, l utilisateur est en train de taper.
      if (i < input.length) i += 1;
    } else {
      while (i < input.length && !/\s/.test(input.charAt(i))) {
        value += input.charAt(i);
        i += 1;
      }
    }

    let prefix = false;
    if (quoted && input.charAt(i) === "*") {
      prefix = true;
      i += 1;
    } else if (!quoted && value.endsWith("*")) {
      prefix = true;
      value = value.slice(0, -1);
    }

    // Un modificateur reste emis meme sans valeur : "from:" seul doit pouvoir
    // etre signale a l utilisateur plutot que disparaitre sans un mot.
    if (value !== "" || quoted || modifier !== undefined) {
      tokens.push({ negated, modifier, hashtag, value, quoted, prefix });
    }
  }

  return tokens;
}

export function parseSearchQuery(input: string): ParsedSearch {
  const include: SearchTerm[] = [];
  const exclude: SearchTerm[] = [];
  const from: string[] = [];
  const notFrom: string[] = [];
  const channels: string[] = [];
  const notChannels: string[] = [];
  const hashtags: string[] = [];
  const notHashtags: string[] = [];
  const ignored: string[] = [];
  let before: string | undefined;
  let after: string | undefined;
  let on: string | undefined;

  for (const token of scan(input)) {
    const value = token.value.trim();

    if (token.modifier !== undefined) {
      if (value === "") {
        ignored.push(`${token.modifier}:`);
        continue;
      }
      switch (token.modifier) {
        case "from":
          (token.negated ? notFrom : from).push(value.replace(/^@/, ""));
          break;
        case "in":
          (token.negated ? notChannels : channels).push(value.replace(/^~/, ""));
          break;
        case "before":
        case "after":
        case "on": {
          if (!isValidDate(value)) {
            ignored.push(`${token.modifier}:${value}`);
            break;
          }
          if (token.modifier === "before") before = value;
          else if (token.modifier === "after") after = value;
          else on = value;
          break;
        }
      }
      continue;
    }

    if (token.hashtag) {
      if (normalizeHashtag(value) === "") {
        ignored.push(`#${value}`);
        continue;
      }
      (token.negated ? notHashtags : hashtags).push(value);
      continue;
    }

    if (!hasSearchableContent(value)) {
      if (value !== "") ignored.push(value);
      continue;
    }

    const term: SearchTerm = { text: value, phrase: token.quoted, prefix: token.prefix };
    (token.negated ? exclude : include).push(term);
  }

  return {
    include,
    exclude,
    from,
    notFrom,
    channels,
    notChannels,
    hashtags,
    notHashtags,
    before,
    after,
    on,
    ignored,
  };
}

/**
 * Neutralise un terme pour FTS5. Tout passe entre guillemets, ce qui rend
 * litteraux les operateurs (AND, OR, NOT, NEAR), les parentheses et les deux
 * points : sans cela, taper "AND" ou une parenthese suffirait a changer le sens
 * de la requete, voire a la rendre invalide. Un guillemet interne se double.
 *
 * L etoile de prefixe reste a l exterieur : entre guillemets, FTS5 la traite
 * comme un caractere ordinaire et la recherche par prefixe ne fonctionne plus.
 */
export function quoteTerm(term: SearchTerm): string {
  return `"${term.text.replace(/"/g, '""')}"${term.prefix ? "*" : ""}`;
}

export interface SearchResolver {
  channelIdByName(name: string): number | undefined;
  userIdByUsername(username: string): number | undefined;
}

export type CompileOutcome =
  | { readonly kind: "ok"; readonly match: string; readonly range: TimeRange }
  /** Rien d exploitable dans la saisie. */
  | { readonly kind: "vide" }
  /** Uniquement des exclusions : FTS5 exige un operande positif a gauche de NOT. */
  | { readonly kind: "sans-terme-positif" }
  /** Un canal ou un auteur cite n existe pas : le resultat est vide, et il faut le dire. */
  | { readonly kind: "introuvable"; readonly names: readonly string[] };

export interface TimeRange {
  readonly fromMs: number | undefined;
  readonly toMs: number | undefined;
}

const DAY_MS = 86_400_000;

function startOfDayMs(date: string, offsetMinutes: number): number {
  const parts = date.split("-").map((part) => Number(part));
  const utcMidnight = Date.UTC(parts[0] ?? 0, (parts[1] ?? 1) - 1, parts[2] ?? 1);
  return utcMidnight - offsetMinutes * 60_000;
}

/**
 * Les bornes suivent la convention Mattermost : before et after excluent le jour
 * cite, on le couvre entierement. Le decalage est celui du lecteur, pas celui du
 * serveur : sans lui, un message ecrit a 00h30 a Paris tomberait la veille.
 *
 * Il se compte positivement a l est de Greenwich, soit 120 pour Paris en ete.
 * C est l oppose de Date.prototype.getTimezoneOffset, dont le signe inverse
 * decalerait toutes les bornes de deux fois le fuseau.
 */
export function timeRangeFor(parsed: ParsedSearch, offsetMinutes = 0): TimeRange {
  let fromMs: number | undefined;
  let toMs: number | undefined;

  if (parsed.on !== undefined) {
    fromMs = startOfDayMs(parsed.on, offsetMinutes);
    toMs = fromMs + DAY_MS - 1;
  }
  if (parsed.after !== undefined) {
    const bound = startOfDayMs(parsed.after, offsetMinutes) + DAY_MS;
    fromMs = fromMs === undefined ? bound : Math.max(fromMs, bound);
  }
  if (parsed.before !== undefined) {
    const bound = startOfDayMs(parsed.before, offsetMinutes) - 1;
    toMs = toMs === undefined ? bound : Math.min(toMs, bound);
  }

  return { fromMs, toMs };
}

function tagGroup(prefix: string, ids: readonly number[]): string {
  const terms = ids.map((value) => `${prefix}${String(value)}`);
  return terms.length === 1 ? `tag:${terms[0] ?? ""}` : `tag:(${terms.join(" OR ")})`;
}

/**
 * Traduit une saisie en expression MATCH. Les filtres de canal et d auteur
 * passent par la colonne tag, donc par une intersection de listes d occurrences,
 * et non par une jointure : c est ce qui fait tenir une restriction a un canal
 * en 80 pages lues au lieu de 5 781.
 */
export function compileSearch(
  parsed: ParsedSearch,
  resolver: SearchResolver,
  offsetMinutes = 0,
): CompileOutcome {
  const unresolved: string[] = [];

  const resolve = <T>(names: readonly string[], lookup: (name: string) => T | undefined): T[] => {
    const found: T[] = [];
    for (const name of names) {
      const id = lookup(name);
      if (id === undefined) unresolved.push(name);
      else found.push(id);
    }
    return found;
  };

  const channelIds = resolve(parsed.channels, (name) => resolver.channelIdByName(name));
  const userIds = resolve(parsed.from, (name) => resolver.userIdByUsername(name));
  const notChannelIds = resolve(parsed.notChannels, (name) => resolver.channelIdByName(name));
  const notUserIds = resolve(parsed.notFrom, (name) => resolver.userIdByUsername(name));

  // Un filtre qui ne designe personne ne doit pas etre ignore : sans cela, une
  // faute de frappe dans un nom d auteur elargirait la recherche au lieu de la
  // restreindre, et l utilisateur lirait un resultat pour un autre.
  if (unresolved.length > 0) {
    return { kind: "introuvable", names: unresolved };
  }

  const positives: string[] = [];
  for (const term of parsed.include) positives.push(`message:${quoteTerm(term)}`);
  for (const tag of parsed.hashtags) positives.push(`tag:${normalizeHashtag(tag)}`);
  if (channelIds.length > 0) positives.push(tagGroup(TAG_PREFIX.CHANNEL, channelIds));
  if (userIds.length > 0) positives.push(tagGroup(TAG_PREFIX.USER, userIds));

  const negatives: string[] = [];
  for (const term of parsed.exclude) negatives.push(`message:${quoteTerm(term)}`);
  for (const tag of parsed.notHashtags) negatives.push(`tag:${normalizeHashtag(tag)}`);
  if (notChannelIds.length > 0) negatives.push(tagGroup(TAG_PREFIX.CHANNEL, notChannelIds));
  if (notUserIds.length > 0) negatives.push(tagGroup(TAG_PREFIX.USER, notUserIds));

  const range = timeRangeFor(parsed, offsetMinutes);
  const hasTimeFilter = range.fromMs !== undefined || range.toMs !== undefined;

  if (positives.length === 0) {
    if (negatives.length > 0) return { kind: "sans-terme-positif" };
    // Une fenetre temporelle seule reste une recherche legitime : elle se traduit
    // en plage de rowid, sans expression MATCH.
    if (hasTimeFilter) return { kind: "ok", match: "", range };
    return { kind: "vide" };
  }

  const included = positives.join(" AND ");
  const match = negatives.length === 0 ? included : `(${included}) NOT (${negatives.join(" OR ")})`;
  return { kind: "ok", match, range };
}
