import DOMPurify from "dompurify";
import MarkdownIt, { type StateCore, type Token } from "markdown-it";

export interface RenderContext {
  /** Noms d utilisateur connus, pour ne mettre en valeur que les vraies mentions. */
  readonly usernames: ReadonlySet<string>;
  /** Noms de canaux connus, pour les liens ~canal. */
  readonly channels: ReadonlyMap<string, number>;
  /** Emojis personnalises presents dans l archive. */
  readonly customEmojis: ReadonlySet<string>;
  emojiUrl(name: string): string;
  /** Rend un shortcode standard, ou undefined s il est inconnu. */
  standardEmoji(name: string): string | undefined;
}

/**
 * html a false : le HTML brut ecrit dans un message est echappe au lieu d etre
 * interprete. Ces messages viennent de centaines de personnes et n ont jamais
 * ete ecrits pour etre rendus ailleurs que dans Mattermost ; les traiter comme
 * du balisage de confiance reviendrait a executer leur contenu dans l origine
 * du viewer.
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

// Les liens s ouvrent dans un onglet neuf, sans transmettre la page d origine.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  token?.attrSet("target", "_blank");
  token?.attrSet("rel", "noopener noreferrer nofollow");
  return defaultLinkOpen(tokens, index, options, env, self);
};

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/** Emojis, mentions et canaux, reconnus dans cet ordre. */
const INLINE_PATTERN = /(?::([a-z0-9_+-]+):)|(?:@([a-z0-9._-]+))|(?:~([a-z0-9._-]+))/gi;

let context: RenderContext | undefined;

function renderMatch(match: RegExpExecArray): string | undefined {
  if (context === undefined) return undefined;
  const [, emoji, mention, channel] = match;

  if (emoji !== undefined) {
    if (context.customEmojis.has(emoji)) {
      const url = escapeHtml(context.emojiUrl(emoji));
      const label = escapeHtml(`:${emoji}:`);
      return `<img class="emoji" src="${url}" alt="${label}" title="${label}" loading="lazy" />`;
    }
    const standard = context.standardEmoji(emoji);
    // Un shortcode inconnu reste affiche tel quel : le remplacer par un
    // caractere de remplacement ferait disparaitre une information.
    return standard === undefined
      ? undefined
      : `<span class="emoji">${escapeHtml(standard)}</span>`;
  }

  if (mention !== undefined) {
    if (!context.usernames.has(mention.toLowerCase())) return undefined;
    return `<span class="mention">@${escapeHtml(mention)}</span>`;
  }

  if (channel !== undefined) {
    const id = context.channels.get(channel.toLowerCase());
    if (id === undefined) return undefined;
    return `<a class="mention" href="#/canal/${String(id)}">~${escapeHtml(channel)}</a>`;
  }

  return undefined;
}

/**
 * Transforme les tokens de texte, jamais la chaine rendue.
 *
 * Travailler sur le HTML deja produit reintroduirait exactement le risque que
 * html a false ecarte : une substitution appliquee au balisage peut fabriquer
 * une balise a partir de fragments inoffensifs. Ici chaque remplacement porte
 * sur du texte, et tout ce qui l entoure reste echappe par le moteur.
 */
function decorate(state: StateCore): void {
  if (context === undefined) return;
  for (const blockToken of state.tokens) {
    if (blockToken.type !== "inline" || blockToken.children === null) continue;
    const rebuilt: Token[] = [];
    let changed = false;

    for (const token of blockToken.children) {
      if (token.type !== "text") {
        rebuilt.push(token);
        continue;
      }
      let last = 0;
      INLINE_PATTERN.lastIndex = 0;
      for (
        let match = INLINE_PATTERN.exec(token.content);
        match !== null;
        match = INLINE_PATTERN.exec(token.content)
      ) {
        const html = renderMatch(match);
        if (html === undefined) continue;
        changed = true;
        if (match.index > last) {
          const before = new state.Token("text", "", 0);
          before.content = token.content.slice(last, match.index);
          rebuilt.push(before);
        }
        const inserted = new state.Token("html_inline", "", 0);
        inserted.content = html;
        rebuilt.push(inserted);
        last = match.index + match[0].length;
      }
      if (last === 0) {
        rebuilt.push(token);
        continue;
      }
      if (last < token.content.length) {
        const tail = new state.Token("text", "", 0);
        tail.content = token.content.slice(last);
        rebuilt.push(tail);
      }
    }

    if (changed) blockToken.children = rebuilt;
  }
}

md.core.ruler.push("mmarchive_inline", decorate);

/**
 * Elements et attributs autorises dans le rendu d un message.
 *
 * markdown-it tourne deja avec html a false, ce qui echappe le balisage ecrit
 * par les auteurs. Cette seconde passe existe parce que ces messages viennent
 * de centaines de personnes et sont rejoues des annees plus tard : faire
 * reposer toute la surete sur une seule option de configuration serait fragile.
 * La liste ne contient que ce que le Markdown produit.
 */
const ALLOWED_TAGS = [
  "p",
  "br",
  "hr",
  "em",
  "strong",
  "s",
  "del",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
  "img",
  "span",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
];

const ALLOWED_ATTR = ["href", "src", "alt", "title", "class", "target", "rel", "loading"];

export function renderMarkdown(text: string, renderContext: RenderContext): string {
  context = renderContext;
  return DOMPurify.sanitize(md.render(text), {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Un lien ou une image ne doit pouvoir designer qu une ressource, jamais un
    // script : ce filtre couvre javascript:, data: et leurs variantes encodees.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/)/i,
  });
}
