import { Agent, setGlobalDispatcher } from "undici";

// The suite starts a fresh server on the same port before every test. node:test runs
// the next test without yielding to the I/O phase in between, so undici can reuse a
// pooled keep-alive connection to the previous (already closed) server: the request
// then fails before reaching the new server ("other side closed") and the test hangs.
// mocha yielded between tests, which hid this race; `pipelining: 0` disables keep-alive.
setGlobalDispatcher(new Agent({ pipelining: 0 }));
