// Run in a worker thread by `headers/linear.test.ts`: `response.type()` of
// inputs that an exponential regular expression would never finish (the
// worker is then terminated), with the CPU time that each takes in the worker
// (see `cpuSince()` of the test: unlike the time of the clock, it does not
// grow while other processes load the machine)
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
  const start = process.threadCpuUsage();
  let outcome = "accepted";
  try {
    response.type(input);
  } catch (error: unknown) {
    outcome = (error as Error).name;
  }
  const { user, system } = process.threadCpuUsage(start);
  return { outcome, ms: (user + system) / 1000 };
});
parentPort?.postMessage(results);
