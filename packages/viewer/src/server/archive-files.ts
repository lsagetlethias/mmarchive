import { isAbsolute, relative, resolve, sep } from "node:path";

export class UnsafeArchivePathError extends Error {
  readonly requested: string;

  constructor(requested: string) {
    super(`Chemin ${JSON.stringify(requested)} en dehors de l archive.`);
    this.name = "UnsafeArchivePathError";
    this.requested = requested;
  }
}

/**
 * Resout un chemin note dans l archive, en garantissant qu il y reste.
 *
 * Les chemins servis viennent de l index, donc de l archive, donc de donnees
 * produites par des tiers. Un chemin remontant vers la racine du disque ferait
 * du viewer un lecteur de fichiers arbitraires : la verification porte sur le
 * chemin resolu, jamais sur la chaine d origine, parce que ".." peut arriver
 * encode, double, ou reconstitue par la normalisation.
 */
export function resolveArchivePath(archiveRoot: string, requested: string): string {
  const root = resolve(archiveRoot);
  const target = resolve(root, requested);
  const inside = relative(root, target);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new UnsafeArchivePathError(requested);
  }
  return target;
}

/** Caracteres surs dans un filename de Content-Disposition, hors guillemets. */
const ASCII_SAFE = /[^\x20-\x7e]|["\\;,]/g;

/**
 * Content-Disposition d un nom de fichier arbitraire.
 *
 * Deux formes cohabitent : filename en ASCII pour les clients anciens, et
 * filename* en UTF-8 percent-encode pour les autres. Sans la premiere, certains
 * clients ne voient aucun nom ; sans la seconde, tout nom accentue est mutile.
 * La valeur est toujours "attachment" : ces fichiers viennent de tiers, les
 * afficher dans l origine du viewer permettrait a un HTML televerse d y
 * executer du script.
 */
export function contentDisposition(name: string): string {
  const fallback = name.replace(ASCII_SAFE, "_") || "fichier";
  const encoded = encodeURIComponent(name);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
