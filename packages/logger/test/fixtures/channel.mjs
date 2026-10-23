// A `pino` transport (loaded by its worker) that posts the message of every
// record it gets on the `BroadcastChannel` named by its `channel` option: a
// target of the tests of `transport`, which tells them what reaches it
import { Writable } from "node:stream";

export default function channel({ channel: name }) {
  const out = new BroadcastChannel(name);
  let rest = "";
  return new Writable({
    write(chunk, _encoding, callback) {
      const lines = `${rest}${chunk}`.split("\n");
      rest = lines.pop();
      for (const line of lines) {
        if (line !== "") {
          out.postMessage(JSON.parse(line).msg);
        }
      }
      callback();
    },
  });
}
