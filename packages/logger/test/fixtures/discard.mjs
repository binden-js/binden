// A `pino` transport (loaded by its worker) that discards the records: a
// target of the tests of `transport`, which writes nowhere
import { Writable } from "node:stream";

export default function discard() {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}
