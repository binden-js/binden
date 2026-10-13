import http from "node:http";

// The suites start a fresh server on the same port before every test. node:test runs
// the next test without yielding to the I/O phase in between, so a keep-alive socket
// of the global agent can be reused after the previous server closed it (ECONNRESET).
// mocha yielded between tests, which hid this race; fresh connections avoid it.
http.globalAgent = new http.Agent({ keepAlive: false });
