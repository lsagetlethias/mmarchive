import type {
  ArchiveClient,
  Channel,
  Message,
  MessageBundle,
  MetaInfo,
  PageOptions,
  SearchOptions,
  SearchOutcome,
  User,
} from "../client/archive-client.js";

interface AssetPayload {
  /** Le tampon est toujours ordinaire : rien n est partage avec le worker. */
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mime: string;
}

/**
 * Client du mode sans serveur.
 *
 * Il expose exactement la meme interface que le client HTTP : c est ce qui
 * permet a l interface de ne rien savoir du mode dans lequel elle tourne. Les
 * requetes voyagent vers le worker, ou elles sont executees par les memes
 * fonctions que cote serveur.
 */
export class WorkerArchiveClient implements ArchiveClient {
  readonly #worker: Worker;
  readonly #pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  readonly #assetUrls = new Map<string, string>();
  #nextId = 1;

  constructor(worker: Worker) {
    this.#worker = worker;
    this.#worker.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as { id: number; ok: boolean; value?: unknown; error?: string };
      const waiting = this.#pending.get(data.id);
      if (waiting === undefined) return;
      this.#pending.delete(data.id);
      if (data.ok) waiting.resolve(data.value);
      else waiting.reject(new Error(data.error ?? "erreur inconnue"));
    });

    // Un worker qui echoue avant d avoir repondu, au chargement du module ou a
    // l instanciation du moteur, ne renverra jamais rien : sans ce relais, les
    // appels en cours resteraient en suspens et l interface afficherait
    // indefiniment son ecran d ouverture.
    this.#worker.addEventListener("error", (event: ErrorEvent) => {
      this.#failAll(event.message === "" ? "le worker a echoue" : event.message);
    });
    this.#worker.addEventListener("messageerror", () => {
      this.#failAll("reponse du worker illisible");
    });
  }

  #failAll(reason: string): void {
    const waiting = [...this.#pending.values()];
    this.#pending.clear();
    for (const { reject } of waiting) reject(new Error(reason));
  }

  #send(message: Record<string, unknown>, transfer?: Transferable[]): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ ...message, id }, transfer ?? []);
    });
  }

  #call<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.#send({ kind: "appel", method, args }) as Promise<T>;
  }

  /** Ouvre un index designe par l utilisateur, pour une consultation hors serveur. */
  async openFile(file: File): Promise<void> {
    await this.#send({ kind: "ouvrir-fichier", file });
  }

  /** Ouvre un index pose sur un hebergement statique, lu par plages. */
  async openUrl(url: string): Promise<void> {
    await this.#send({ kind: "ouvrir-url", url });
  }

  async meta(): Promise<MetaInfo> {
    return this.#call<MetaInfo>("meta");
  }

  async channels(): Promise<readonly Channel[]> {
    return this.#call<Channel[]>("channels");
  }

  async users(): Promise<readonly User[]> {
    return this.#call<User[]>("users");
  }

  async customEmojis(): Promise<readonly string[]> {
    return this.#call<string[]>("customEmojis");
  }

  async channelMessages(channelId: number, options?: PageOptions): Promise<MessageBundle> {
    return this.#call<MessageBundle>("channelMessages", channelId, options ?? {});
  }

  async messageContext(messageId: number): Promise<MessageBundle & { focus: number }> {
    return this.#call<MessageBundle & { focus: number }>("messageContext", messageId);
  }

  async thread(rootId: number): Promise<MessageBundle> {
    return this.#call<MessageBundle>("thread", rootId);
  }

  async search(query: string, options?: SearchOptions): Promise<SearchOutcome> {
    return this.#call<SearchOutcome>("search", query, options ?? {});
  }

  async permalink(pid: string): Promise<Message | null> {
    return this.#call<Message | null>("permalink", pid);
  }

  /**
   * Les pieces jointes ne voyagent pas dans l index : 26 Go n ont pas vocation a
   * y entrer. Leur metadonnee reste affichee, avec la mention qui convient.
   */
  fileUrl(): string {
    return "";
  }

  avatarUrl(uid: string): string {
    return this.#assetUrls.get(`avatar:${uid}`) ?? "";
  }

  emojiUrl(name: string): string {
    return this.#assetUrls.get(`emoji:${name}`) ?? "";
  }

  /**
   * Rend une ressource utilisable comme source d image.
   *
   * L adresse est fabriquee une fois puis conservee : chaque appel a
   * createObjectURL retient ses octets jusqu a revocation, et un avatar affiche
   * deux cents fois en produirait deux cents copies.
   */
  async loadAsset(kind: "avatar" | "emoji", key: string): Promise<string | null> {
    const cacheKey = `${kind}:${key}`;
    const known = this.#assetUrls.get(cacheKey);
    if (known !== undefined) return known;
    const payload = await this.#call<AssetPayload | null>("asset", kind, key);
    if (payload === null) return null;
    const url = URL.createObjectURL(new Blob([payload.bytes], { type: payload.mime }));
    this.#assetUrls.set(cacheKey, url);
    return url;
  }

  /**
   * Prepare tous les emojis personnalises.
   *
   * Ils sont rendus dans le corps des messages, sous forme de balisage produit
   * par le moteur Markdown : leur adresse doit donc etre connue au moment du
   * rendu, sans attente. L archive de reference en compte 762, pour 18 Mo.
   */
  async preloadEmojis(): Promise<number> {
    const all = await this.#call<Record<string, AssetPayload>>("tous-emojis");
    for (const [name, payload] of Object.entries(all)) {
      const url = URL.createObjectURL(new Blob([payload.bytes], { type: payload.mime }));
      this.#assetUrls.set(`emoji:${name}`, url);
    }
    return Object.keys(all).length;
  }

  /** Nombre de ressources deja resolues, pour les diagnostics. */
  get resolvedAssets(): number {
    return this.#assetUrls.size;
  }
}
