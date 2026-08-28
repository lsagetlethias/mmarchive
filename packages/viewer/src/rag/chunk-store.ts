/**
 * Ecriture et relecture de la reserve de fragments.
 *
 * Rien n est envoye nulle part ici : cette etape produit le texte a vectoriser,
 * et reste utile meme si aucun fournisseur n est jamais configure. Les vecteurs
 * viendront dans une table a part, quand la dimension sera tranchee.
 */
import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IndexReadError } from "../query/driver.js";
import {
  CHUNK_DEFAULTS,
  type ChunkOptions,
  chunkThreads,
  chunkWindows,
  type Fragment,
} from "./chunk.js";
import {
  contexteDepuis,
  lisant,
  ORDRE_CANAUX,
  ORDRE_FILS,
  parcourir,
  racines,
  seulementFils,
  seulementIsoles,
} from "./read.js";
import {
  indexFingerprint,
  missingStoreTables,
  STORE_DDL,
  STORE_INDEXES,
  writeStoreMeta,
} from "./store-schema.js";

export interface StoreReport {
  readonly fragments: number;
  readonly threads: number;
  readonly windows: number;
  readonly chars: number;
  readonly seconds: number;
}

export interface BuildStoreOptions extends ChunkOptions {
  readonly indexPath: string;
  readonly output: string;
  readonly force?: boolean;
}

export async function buildChunkStore(options: BuildStoreOptions): Promise<StoreReport> {
  const debut = Date.now();

  // Le fichier d entree et celui de sortie ne peuvent pas etre le meme. Sans ce
  // controle, --force effacerait l index en cours de lecture, et sans --force on
  // ecrirait le schema des fragments dedans.
  if (resolve(options.indexPath) === resolve(options.output)) {
    throw new IndexReadError(
      "L index et la reserve de fragments ne peuvent pas etre le meme fichier : la construction lit l un pour ecrire l autre.",
    );
  }
  // Refuser avant d ouvrir quoi que ce soit. Ouvrir d abord ferait echouer la
  // creation des tables sur une reserve existante, et le nettoyage d erreur la
  // supprimerait alors qu on avait justement refuse de la remplacer.
  if (options.force !== true && existsSync(options.output)) {
    throw new IndexReadError(
      `${options.output} existe deja. Relancez avec --force pour le remplacer : la reserve est entierement reconstruite, jamais completee.`,
    );
  }

  const index = new DatabaseSync(options.indexPath, { readOnly: true });
  // Ecriture dans un fichier temporaire, renomme a la fin. C est ce qui permet
  // de ne jamais toucher a une reserve existante tant que la nouvelle n est pas
  // complete, et de n effacer que ce que cette execution a cree.
  const temporaire = `${options.output}.partiel`;
  let sortie: DatabaseSync | undefined;
  let echoue = false;
  try {
    const connues = lisant(() => racines(index));
    const contexte = lisant(() => contexteDepuis(index));
    const empreinte = lisant(() => indexFingerprint(index));

    await rm(temporaire, { force: true });
    sortie = new DatabaseSync(temporaire);
    // Ces donnees sont derivees de l index, lui meme derive de l archive : les
    // perdre ne coute qu une reconstruction, pas une garantie de durabilite.
    sortie.exec("PRAGMA journal_mode = OFF");
    sortie.exec("PRAGMA synchronous = OFF");
    sortie.exec(STORE_DDL);

    const insertFragment = sortie.prepare(
      `INSERT INTO fragment (ch, root, first_id, last_id, first_at, last_at, part, messages, text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertUser = sortie.prepare("INSERT INTO fragment_user (fragment, usr) VALUES (?, ?)");

    let fragments = 0;
    let threads = 0;
    let windows = 0;
    let chars = 0;

    sortie.exec("BEGIN");
    const ecrire = (source: Iterable<Fragment>, compter: () => void): void => {
      for (const f of source) {
        const { lastInsertRowid } = insertFragment.run(
          f.ch,
          f.root,
          f.firstId,
          f.lastId,
          f.firstAt,
          f.lastAt,
          f.part,
          f.messages,
          f.text,
        );
        for (const usr of f.users) insertUser.run(lastInsertRowid, usr);
        fragments += 1;
        chars += f.text.length;
        compter();
      }
    };

    lisant(() => {
      ecrire(
        chunkThreads(seulementFils(parcourir(index, ORDRE_FILS), connues), contexte, options),
        () => {
          threads += 1;
        },
      );
      ecrire(
        chunkWindows(seulementIsoles(parcourir(index, ORDRE_CANAUX), connues), contexte, options),
        () => {
          windows += 1;
        },
      );
    });
    sortie.exec("COMMIT");

    sortie.exec(STORE_INDEXES);
    writeStoreMeta(sortie, {
      indexFingerprint: empreinte,
      builtAt: new Date().toISOString(),
      gapMs: options.gapMs ?? CHUNK_DEFAULTS.gapMs,
      maxMessages: options.maxMessages ?? CHUNK_DEFAULTS.maxMessages,
      maxChars: options.maxChars ?? CHUNK_DEFAULTS.maxChars,
    });

    sortie.close();
    sortie = undefined;
    await rm(options.output, { force: true });
    await rename(temporaire, options.output);

    return {
      fragments,
      threads,
      windows,
      chars,
      seconds: (Date.now() - debut) / 1000,
    };
  } catch (error) {
    echoue = true;
    throw error;
  } finally {
    index.close();
    sortie?.close();
    // Seul le temporaire est efface. Une reserve a moitie ecrite serait pire
    // qu absente, elle passerait le controle de presence des tables et servirait
    // des fragments incomplets ; une reserve deja en place, elle, n a rien
    // demande et reste intacte.
    if (echoue) await rm(temporaire, { force: true });
  }
}

/**
 * Ouvre une reserve de fragments et refuse celles qui ne correspondent plus.
 *
 * Le controle d empreinte n est pas une precaution de principe. Les fragments
 * designent les messages par leur rowid, et cette numerotation se decale des
 * qu un message est ajoute ou efface. Servir une reserve perimee ferait citer
 * au RAG des messages qu il n a jamais lus, sans la moindre erreur visible.
 */
export function openChunkStore(path: string, index: DatabaseSync): DatabaseSync {
  let store: DatabaseSync;
  try {
    store = new DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    throw new IndexReadError(
      `Reserve de fragments ${path} illisible. Construisez la avec mmarchive-index chunks.`,
      { cause },
    );
  }

  try {
    const tables = store
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name));
    const manquantes = missingStoreTables(tables);
    if (manquantes.length > 0) {
      throw new IndexReadError(
        `${path} n a pas la forme attendue, il manque : ${manquantes.join(", ")}. Reconstruisez la avec mmarchive-index chunks.`,
      );
    }

    const attendue = String(
      store.prepare("SELECT value FROM meta WHERE key = 'index_fingerprint'").get()?.value ?? "",
    );
    const reelle = indexFingerprint(index);
    if (attendue !== reelle) {
      throw new IndexReadError(
        `${path} a ete construite depuis un autre index. Les fragments designent les messages par leur position, qui se decale des qu un message est ajoute ou efface : les servir ferait citer des messages faux. Reconstruisez la avec mmarchive-index chunks.`,
      );
    }
    return store;
  } catch (error) {
    store.close();
    throw error;
  }
}
