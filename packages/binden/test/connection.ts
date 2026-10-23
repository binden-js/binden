import { connect } from "node:net";
import { once } from "node:events";

/** What a client has received on its connection, and whether it has closed */
export interface IConversation {
  readonly received: string;
  readonly closed: boolean;
}

/** How a conversation is read (see `converse()`) */
export interface IConverseOptions {
  /** Whether what has been received is complete (the conversation ends then) */
  readonly complete?: ((received: string) => boolean) | undefined;
  /** Nothing is read until it resolves (e.g. a reply that must not finish before) */
  readonly hold?: Promise<unknown> | undefined;
  /** The deadline of the conversation (a hang must fail, not block the runner) */
  readonly ms?: number | undefined;
}

/**
 * Writes `text` (e.g. pipelined requests) on a new connection to the port of
 * `127.0.0.1`, then reads (`latin1`) until what has been received is
 * `complete`, or the connection closes: never judged by silence. Rejects
 * once `ms` (10 s by default) have passed.
 */
export async function converse(
  port: number,
  text: string,
  { complete = (): boolean => false, hold, ms = 10_000 }: IConverseOptions = {},
): Promise<IConversation> {
  const socket = connect(port, "127.0.0.1");
  try {
    await once(socket, "connect");
    let received = "";
    const { promise, resolve, reject } = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => {
      reject(
        new Error(`No end within ${String(ms)} ms: ${received.slice(-200)}`),
      );
    }, ms);
    socket
      .setEncoding("latin1")
      .on("data", (chunk: string) => {
        received += chunk;
        if (complete(received)) {
          resolve(false);
        }
      })
      .on("error", () => {
        // Its close follows
      })
      .on("close", () => {
        resolve(true);
      });
    if (typeof hold !== "undefined") {
      socket.pause();
      const resume = (): void => {
        socket.resume();
      };
      hold.then(resume, resume);
    }
    socket.write(text);
    try {
      const closed = await promise;
      return { received, closed };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    socket.destroy();
  }
}

/** A `GET` of the path on a connection that may be kept alive */
export function get(path: string): string {
  return `GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`;
}
