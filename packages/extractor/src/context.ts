import { MattermostApi } from "./mattermost/api.js";
import { MattermostClient } from "./mattermost/http-client.js";
import type { ConnectionOptions } from "./config/options.js";
import type { Logger } from "./ui/logger.js";

export interface ClientContext {
  readonly client: MattermostClient;
  readonly api: MattermostApi;
}

export function createContext(
  connection: ConnectionOptions,
  options: { rateLimit: number; logger: Logger },
): ClientContext {
  const client = new MattermostClient({
    baseUrl: connection.url,
    token: connection.token,
    rateLimit: options.rateLimit,
    onRetry: (info) => {
      options.logger.debug(
        `Nouvelle tentative sur ${info.template} (${info.reason}) dans ${String(info.delayMs)} ms.`,
      );
    },
  });
  return { client, api: new MattermostApi(client) };
}
