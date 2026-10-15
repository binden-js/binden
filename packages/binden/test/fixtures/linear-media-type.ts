// Run in a worker thread by `headers/linear.test.ts`: `response.type()` of
// inputs that an exponential regular expression would never finish (the
// worker is then terminated), with the time each takes
import { BindenResponse } from "../../index.js";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { parentPort } from "node:worker_threads";

const response = new BindenResponse(new IncomingMessage(new Socket()));
const inputs = [
  // Each ` ;` doubled the time (71 characters took 73 s)
  `text/plain${" ;".repeat(40)}\x01`,
  `text/plain${" ;".repeat(7500)}\x01`,
  `text/plain;${"\t".repeat(15_000)}a=b\x01`,
  `text/plain; a="${'\\"'.repeat(7500)}`,
  `text/plain; a=${"b".repeat(15_000)} \x01`,
  `${" ".repeat(15_000)}text/plain${" ".repeat(15_000)}\x01`,
];
const results = inputs.map((input) => {
  const start = performance.now();
  let outcome = "accepted";
  try {
    response.type(input);
  } catch (error: unknown) {
    outcome = (error as Error).name;
  }
  return { outcome, ms: performance.now() - start };
});
parentPort?.postMessage(results);
