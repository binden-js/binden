import { Agent, setGlobalDispatcher } from "undici";
import http from "node:http";

// Every request gets a fresh connection, which the client closes after the response:
// some tests depend on it (e.g. a response that is complete once the client has its
// body closes early), and a pooled keep-alive socket would outlive its test.
http.globalAgent = new http.Agent({ keepAlive: false });
setGlobalDispatcher(new Agent({ pipelining: 0 }));
