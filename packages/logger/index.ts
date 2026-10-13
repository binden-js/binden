import pino, {
  stdSerializers,
  Bindings,
  Logger as PinoLogger,
  LoggerOptions as PinoLoggerOptions,
  DestinationStream,
  LevelWithSilent,
} from "pino";

export interface LoggerOptions extends PinoLoggerOptions {
  destination?: DestinationStream;
  logger?: PinoLogger;
}

const serializers = {
  error: stdSerializers.err,
  request: stdSerializers.req,
  response: stdSerializers.res,
};

export class Logger {
  readonly #logger: PinoLogger;

  public constructor({ logger, destination, ...options }: LoggerOptions = {}) {
    this.#logger = destination
      ? pino({ level: Logger.getLevel(), serializers, ...options }, destination)
      : logger ?? pino({ level: Logger.getLevel(), serializers, ...options });
  }

  public child(params: Bindings = {}): Logger {
    return new Logger({ logger: this.#logger.child(params) });
  }

  public fatal(message: string, extra: Record<string, unknown> = {}): void {
    this.#logger.fatal(extra, message);
  }

  public error(message: string, extra: Record<string, unknown> = {}): void {
    this.#logger.error(extra, message);
  }

  public warn(message: string, extra: Record<string, unknown> = {}): void {
    this.#logger.warn(extra, message);
  }

  public info(message: string, extra: Record<string, unknown> = {}): void {
    this.#logger.info(extra, message);
  }

  public debug(message: string, extra: Record<string, unknown> = {}): void {
    this.#logger.debug(extra, message);
  }

  public trace(message: string, extra: Record<string, unknown> = {}): void {
    this.#logger.trace(extra, message);
  }

  public static get ENV_VARIABLE_NAME(): string {
    return "BINDEN_LOG_LEVEL";
  }

  public static getLevel(env_name = this.ENV_VARIABLE_NAME): LevelWithSilent {
    const {
      env: { [env_name]: LEVEL },
    } = process;

    const level = LEVEL?.trim().toLowerCase();

    switch (level) {
      case "trace":
      case "debug":
      case "info":
      case "warn":
      case "error":
      case "fatal":
        return level;
      default:
        return "silent";
    }
  }
}

export default new Logger();
