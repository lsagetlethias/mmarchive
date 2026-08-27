import type {
  ArchiveClient,
  Channel,
  Message,
  MessageBundle,
  MetaInfo,
  PageOptions,
  SearchOutcome,
  User,
} from "./archive-client.js";

export class ArchiveRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ArchiveRequestError";
    this.status = status;
  }
}

function query(options: PageOptions | undefined, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.before !== undefined) params.set("before", String(options.before));
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/** Client du mode full : le serveur execute les requetes, l interface les affiche. */
export class HttpArchiveClient implements ArchiveClient {
  readonly #base: string;

  constructor(base = "") {
    this.#base = base.replace(/\/$/, "");
  }

  async #json<T>(path: string): Promise<T> {
    const response = await fetch(`${this.#base}${path}`);
    if (!response.ok) {
      const detail = await response
        .json()
        .then((body: unknown) =>
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: unknown }).error)
            : response.statusText,
        )
        .catch(() => response.statusText);
      throw new ArchiveRequestError(response.status, detail);
    }
    return (await response.json()) as T;
  }

  async meta(): Promise<MetaInfo> {
    return this.#json<MetaInfo>("/api/meta");
  }

  async channels(): Promise<readonly Channel[]> {
    const body = await this.#json<{ channels: Channel[] }>("/api/channels");
    return body.channels;
  }

  async users(): Promise<readonly User[]> {
    const body = await this.#json<{ users: User[] }>("/api/users");
    return body.users;
  }

  async channelMessages(channelId: number, options?: PageOptions): Promise<MessageBundle> {
    return this.#json<MessageBundle>(
      `/api/channels/${String(channelId)}/messages${query(options)}`,
    );
  }

  async messageContext(messageId: number): Promise<MessageBundle & { focus: number }> {
    return this.#json<MessageBundle & { focus: number }>(
      `/api/messages/${String(messageId)}/context`,
    );
  }

  async thread(rootId: number): Promise<MessageBundle> {
    return this.#json<MessageBundle>(`/api/threads/${String(rootId)}`);
  }

  async search(text: string, options?: PageOptions): Promise<SearchOutcome> {
    return this.#json<SearchOutcome>(`/api/search${query(options, { q: text })}`);
  }

  async permalink(pid: string): Promise<Message | null> {
    try {
      const body = await this.#json<{ message: Message }>(
        `/api/permalink/${encodeURIComponent(pid)}`,
      );
      return body.message;
    } catch (error) {
      // Un permalien qui ne designe rien n est pas une panne : le message peut
      // simplement ne pas faire partie de ce qui a ete archive.
      if (error instanceof ArchiveRequestError && error.status === 404) return null;
      throw error;
    }
  }

  fileUrl(fid: string): string {
    return `${this.#base}/files/${encodeURIComponent(fid)}`;
  }

  avatarUrl(uid: string): string {
    return `${this.#base}/avatars/${encodeURIComponent(uid)}`;
  }

  emojiUrl(name: string): string {
    return `${this.#base}/emoji/${encodeURIComponent(name)}`;
  }
}
