import {
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
  request as httpRequest,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Logger } from "@binden/logger";
import { once } from "node:events";
import { serializers } from "../index.js";

/**
 * A caught value as the reason of a rejection: the `Error` itself (assertions
 * throw one), or an `Error` of its text
 */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Resolves after `ms` milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The result of a promise, which must settle within `ms` milliseconds. The
 * default only guards against a hang, with a deadline that a loaded machine
 * does not reach: a test that asserts a timing passes its own
 */
export async function within<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    reject(new Error(`Not settled within ${ms} ms`));
  }, ms);
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves after a turn of the pending I/O (two turns of `setImmediate()`):
 * once a stall of the process (e.g. a loaded machine) has passed, the timers
 * run before the I/O that has come meanwhile is read, and the `close` of a
 * socket whose end is read then is emitted only once the first turn has run
 * (in the close callbacks of the event loop), so that silence (or an expired
 * deadline) is judged only after both
 */
export async function ioTurn(): Promise<void> {
  for (let turn = 0; turn < 2; turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/**
 * Resolves once `check()` holds (polled every 5 ms), or rejects once it has
 * not within `ms` milliseconds, judged after a turn of the pending I/O (see
 * `ioTurn()`): a poller that ends by itself, whoever waits for it (e.g. a
 * `within()` with a shorter deadline), so that a failure never keeps the
 * process of a test alive
 */
export async function pollUntil(
  check: () => boolean,
  ms = 10_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      await ioTurn();
      if (check()) {
        return;
      }
      throw new Error(`Not true within ${ms} ms: ${String(check)}`);
    }
    await sleep(5);
  }
}

/** A promise that never settles (e.g. a middleware that hangs) */
export function never<T = void>(): Promise<T> {
  return new Promise<T>(() => {
    // Never settles
  });
}

/** A logger whose records are kept */
export interface ICaptured {
  readonly logger: Logger;
  /** The records written so far */
  readonly records: Record<string, unknown>[];
  /** The records written so far, as written */
  output(): string;
  /**
   * Resolves once a record with this message has been written (within `ms`,
   * 10 s by default)
   */
  waitFor(message: string, ms?: number): Promise<Record<string, unknown>>;
}

/** A `Logger` (at `level`) whose records are kept */
export function capture(level = "debug"): ICaptured {
  const lines: string[] = [];
  const logger = new Logger({
    destination: {
      write(line: string): void {
        lines.push(line);
      },
    },
    level,
    serializers,
  });
  const records = (): Record<string, unknown>[] =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    logger,
    get records(): Record<string, unknown>[] {
      return records();
    },
    output: (): string => lines.join(""),
    waitFor: async (
      message: string,
      ms = 10_000,
    ): Promise<Record<string, unknown>> => {
      const find = (): Record<string, unknown> | undefined =>
        records().find(({ msg }) => msg === message);
      await pollUntil(() => typeof find() !== "undefined", ms).catch(() => {
        throw new Error(`No record "${message}": ${lines.join("")}`);
      });
      return find() as Record<string, unknown>;
    },
  };
}

/** A listening server of an application */
export interface IListening {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/** An application, whatever its state */
export interface IApp {
  createServer(): Server;
}

/**
 * The address of the test servers, which their clients connect to: never `::`
 * (as `listen(0)` without a host binds), whose port may be one that a foreign
 * process listens on at 127.0.0.1 (its connections would reach that process)
 */
export const HOST = "127.0.0.1";

/** Creates the server of the application and listens on a free port of `HOST` */
export async function listen(app: IApp): Promise<IListening> {
  const server: Server = app.createServer();
  server.listen(0, HOST);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    server,
    port,
    url: `http://${HOST}:${port}`,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

/** A response, as received */
export interface IReceived {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/**
 * Sends a request (on a new connection to `HOST`) and reads the response within
 * `ms` (10 s by default: a guard against a hang)
 */
export function send(
  port: number,
  {
    path = "/",
    method = "GET",
    headers = {},
    body = null,
    ms = 10_000,
  }: {
    path?: string;
    method?: string;
    headers?: OutgoingHttpHeaders;
    body?: string | null;
    ms?: number;
  } = {},
): Promise<IReceived> {
  return new Promise<IReceived>((resolve, reject) => {
    const sent = httpRequest(
      {
        agent: false,
        headers,
        host: HOST,
        method,
        path,
        port,
        signal: AbortSignal.timeout(ms),
      },
      (response) => {
        let received = "";
        response
          .setEncoding("utf8")
          .on("data", (chunk: string) => {
            received += chunk;
          })
          .once("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: received,
            });
          })
          .once("error", reject);
      },
    );
    sent.once("error", reject);
    if (body !== null) {
      sent.write(body);
    }
    sent.end();
  });
}
