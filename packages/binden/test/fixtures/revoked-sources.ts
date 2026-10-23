// Run by `revoked-sources.test.ts`, without handlers of the process: the
// sources of a failed pipe of a work are unpiped once the work is revoked (see
// `[kRevoke]()`), on a tick of their own. A source whose cleanup throws (its
// `unpipe()`, or a trap of a proxy) must not crash the process: it is only
// logged, the other sources are unpiped all the same, and the revocation
// resolves. Nor does the revocation of a work that is `undefined`, without a
// failure.
import { kOwnership, kPipeFailure, kRevoke } from "../../src/seal.js";
import { BindenResponse } from "../../index.js";
import { EventEmitter } from "node:events";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

const response = new BindenResponse(new IncomingMessage(new Socket()));
const logged: unknown[] = [];
response[kOwnership]({
  fail: () => false,
  guards: () => false,
  replier: () => null,
  native: () => false,
  debug: (message: string, error: unknown) => {
    logged.push(`${message}: ${(error as Error).message}`);
  },
  warn: () => null,
  note: () => null,
});

/** A source piped into the response, whose `unpipe()` records its calls */
class Recorded extends EventEmitter {
  public calls = 0;
  public constructor() {
    super();
    // Its state, as Node.js keeps it, which pipes into the response
    Object.assign(this, { _readableState: { pipes: [response] } });
  }
  public unpipe(destination: unknown): this {
    this.calls += destination === response ? 1 : 0;
    return this;
  }
}

/** A source piped into the response, whose `unpipe()` throws */
class Hostile extends Recorded {
  // eslint-disable-next-line class-methods-use-this -- throws
  public override unpipe(): this {
    throw new Error("A hostile unpipe");
  }
}

const owner = {};
const recorded = new Recorded();
for (const source of [
  new Hostile(),
  new Proxy(new EventEmitter(), {
    getPrototypeOf(): never {
      throw new Error("A hostile trap");
    },
  }),
  recorded,
]) {
  response[kPipeFailure](owner, new Error("A failure"), source);
}
await response[kRevoke]([owner], null);
process.stdout.write(`${JSON.stringify([recorded.calls, logged])}\n`);
// eslint-disable-next-line no-undefined -- a work that is `undefined`
await response[kRevoke]([undefined as never], null);
process.stdout.write("an undefined work: revoked\n");
