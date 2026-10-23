# Security policy

## Supported versions

All the packages of this repository (`binden`, `@binden/logger`, `@binden/body`,
`@binden/compression` and `@binden/multipart`) share one version. Security fixes are released for
the latest 4.x release only: update every package to it.

| Version                                                              | Supported |
| -------------------------------------------------------------------- | --------- |
| 4.x (the latest release)                                             | Yes       |
| Earlier releases (`binden` 2.x and below, `@binden/*` 3.x and below) | No        |

## Reporting a vulnerability

Please do not report vulnerabilities in public issues, pull requests or discussions. Report them
privately through [GitHub](https://github.com/binden-js/binden/security/advisories/new) (Security
→ Report a vulnerability), with:

- the affected package and version, and the version of Node.js;
- the impact, and the steps to reproduce it (e.g. a minimal server and the request that it gets);
- a fix, if you have one in mind.

## What to expect

- An acknowledgement of the report within 7 days.
- An assessment (whether it is a vulnerability, its severity and the affected versions) within 14
  days of the report.
- A fixed release, or a plan for the disclosure agreed with you, within 90 days of the report.

Once the fix is released, a [security advisory](https://github.com/binden-js/binden/security/advisories)
describes the vulnerability (with a CVE when it applies), and credits the reporter unless they
prefer otherwise.

The limits that the documentation states (e.g. the trust boundary of `sendFile()` with `root`, or
a server without the limits and the timeouts of the [production guide](PRODUCTION.md)) are not
vulnerabilities by themselves; a way around them is.
