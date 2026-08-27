import type { Attachment, Channel, Message, Reaction, User } from "../../../src/query/queries.js";

export type { Attachment, Channel, Message, Reaction, User };

/**
 * Une page de messages arrive avec ses reactions et ses pieces jointes : les
 * demander separement ferait un appel par message la ou le serveur les lit en
 * une plage de rowid.
 */
export interface MessageBundle {
  readonly messages: readonly Message[];
  readonly reactions: readonly Reaction[];
  readonly attachments: readonly Attachment[];
  /** Nombre de reponses, par identifiant de message racine. */
  readonly replyCounts: Readonly<Record<string, number>>;
  readonly nextCursor: number | null;
}

export interface MetaInfo {
  readonly builtAt: string | null;
  readonly counts: { readonly posts: number; readonly channels: number; readonly users: number };
}

export type SearchOutcome =
  | ({ readonly status: "ok" } & MessageBundle)
  | { readonly status: "vide" }
  | { readonly status: "sans-terme-positif" }
  | { readonly status: "introuvable"; readonly names: readonly string[] };

export interface PageOptions {
  readonly limit?: number;
  readonly before?: number;
}

export interface SearchOptions extends PageOptions {
  /**
   * Decalage du lecteur, positif a l est de Greenwich. Sans lui, les bornes de
   * dates sont comprises en temps universel et un message ecrit en soiree
   * bascule sur la veille.
   */
  readonly timeZoneOffsetMinutes?: number;
}

/**
 * Seul contrat que connait l interface.
 *
 * Le mode full l implemente par des appels HTTP, le mode lite par un worker qui
 * interroge SQLite compile en WebAssembly. Aucun composant ne doit contourner
 * cette frontiere : c est elle qui rend le mode lite possible sans reecrire
 * l interface.
 */
export interface ArchiveClient {
  meta(): Promise<MetaInfo>;
  channels(): Promise<readonly Channel[]>;
  users(): Promise<readonly User[]>;
  /** Noms des emojis personnalises presents dans l archive. */
  customEmojis(): Promise<readonly string[]>;
  channelMessages(channelId: number, options?: PageOptions): Promise<MessageBundle>;
  messageContext(messageId: number): Promise<MessageBundle & { readonly focus: number }>;
  thread(rootId: number): Promise<MessageBundle>;
  search(query: string, options?: SearchOptions): Promise<SearchOutcome>;
  permalink(pid: string): Promise<Message | null>;
  /** Adresse d une piece jointe, d un avatar ou d un emoji custom. */
  fileUrl(fid: string): string;
  avatarUrl(uid: string): string;
  emojiUrl(name: string): string;
}
