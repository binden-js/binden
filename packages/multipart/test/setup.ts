import { Agent, setGlobalDispatcher } from "undici";
import http from "node:http";

// The suite starts a fresh server on the same port before every test. node:test runs
// the next test without yielding to the I/O phase in between, so a pooled keep-alive
// connection to the previous (already closed) server could be reused. Disable keep-alive
// for `node:http` requests and for `fetch` (the undici global dispatcher is shared with
// the built-in `fetch`).
http.globalAgent = new http.Agent({ keepAlive: false });
setGlobalDispatcher(new Agent({ pipelining: 0 }));
