/** Corps d erreur standard Mattermost. Aucun champ n est garanti par la spec. */
export interface MattermostAppError {
  readonly id?: string;
  readonly message?: string;
  readonly detailed_error?: string;
  readonly request_id?: string;
  readonly status_code?: number;
}

export class MattermostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class MattermostHttpError extends MattermostError {
  readonly status: number;
  readonly method: string;
  readonly template: string;
  readonly appError: MattermostAppError | undefined;

  constructor(input: {
    status: number;
    method: string;
    template: string;
    appError?: MattermostAppError | undefined;
    bodyText?: string | undefined;
  }) {
    const detail = input.appError?.message ?? input.bodyText?.slice(0, 200) ?? "";
    super(
      `${input.method} ${input.template} a repondu ${String(input.status)}${
        detail ? ` : ${detail}` : ""
      }`,
    );
    this.status = input.status;
    this.method = input.method;
    this.template = input.template;
    this.appError = input.appError;
  }
}

export class MattermostAuthError extends MattermostHttpError {}

export class MattermostForbiddenError extends MattermostHttpError {}

export class MattermostNotFoundError extends MattermostHttpError {}

export class MattermostRateLimitError extends MattermostHttpError {
  /** Duree d attente deduite des en-tetes, en millisecondes. */
  readonly retryAfterMs: number;

  constructor(
    input: {
      status: number;
      method: string;
      template: string;
      appError?: MattermostAppError | undefined;
      bodyText?: string | undefined;
    },
    retryAfterMs: number,
  ) {
    super(input);
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Levee quand du code tente d appeler un endpoint qui modifie l instance sans
 * passer par la porte de consentement. C est le garde-fou central de mmarchive :
 * rejoindre un canal publie un message systeme visible par tous ses membres.
 */
export class ForbiddenMutationError extends MattermostError {
  readonly template: string;

  constructor(template: string, method: string) {
    super(
      `Appel refuse : ${method} ${template} modifie l instance Mattermost. ` +
        `Toute mutation doit passer par MutationGate avec un consentement explicite de l utilisateur.`,
    );
    this.template = template;
  }
}

/**
 * Levee quand une mutation vise une cible absente du consentement. Signale un
 * bug, pas une erreur utilisateur : la selection et le consentement ont diverge.
 */
export class ConsentViolationError extends MattermostError {
  readonly targetId: string;

  constructor(kind: "canal" | "team", targetId: string) {
    super(
      `Refus : le ${kind} ${targetId} ne figure pas dans le consentement accorde par l utilisateur. ` +
        `Aucune modification n a ete envoyee a l instance.`,
    );
    this.targetId = targetId;
  }
}

export class NetworkError extends MattermostError {
  constructor(message: string, cause: unknown) {
    super(message);
    this.cause = cause;
  }
}

/**
 * Reponse dont la FORME ne correspond pas au contrat attendu, par opposition a
 * une erreur de statut HTTP. Typiquement un JSON valide mais dont un champ dont
 * on depend est absent ou mal type.
 */
export class MattermostResponseError extends MattermostError {}
