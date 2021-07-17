import Pino from "pino";

const ENV_VARIABLE_NAME = "KAUAI_LOG_LEVEL";

const serializers = {
  error: Pino.stdSerializers.err,
  request: Pino.stdSerializers.req,
  response: Pino.stdSerializers.res,
};

const formatters = {
  level: (label: string): { level: string } => ({ level: label }),
};

export class Logger {
  readonly #logger: Pino.Logger;

  public constructor(
    options: Pino.LoggerOptions = {},
    logger: Pino.Logger = Pino({ formatters, serializers, ...options })
  ) {
    this.#logger = logger;
  }

  public child(params: Pino.Bindings = {}): Logger {
    return new Logger({}, this.#logger.child(params));
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

  public static getLevel(env_name = ENV_VARIABLE_NAME): string {
    const { [env_name]: LEVEL } = process.env;
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

export default new Logger({ level: Logger.getLevel() });
