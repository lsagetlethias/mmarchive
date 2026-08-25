/**
 * Applique un traitement concurrent en FENETRE GLISSANTE, et renvoie les
 * resultats dans l ordre d origine.
 *
 * A ne pas confondre avec un traitement par tranches successives, ou l on
 * attend la fin de tout un lot avant d entamer le suivant. Une tranche coute le
 * temps de son element le PLUS LENT, pas la moyenne : sur des pieces jointes
 * dont la taille va de quelques kilo-octets a plusieurs dizaines de mega-octets,
 * une tranche de cinq passe l essentiel de son temps a attendre un seul gros
 * fichier pendant que les quatre autres connexions dorment. Mesure sur l archive
 * reelle : la concurrence effective d une tranche de cinq tombait a 1,35.
 *
 * Ici, chaque coroutine tire l element suivant des qu elle se libere, donc la
 * fenetre reste pleine tant qu il reste du travail.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (index >= items.length || item === undefined) return;
        results[index] = await worker(item, index);
      }
    }),
  );

  return results;
}
