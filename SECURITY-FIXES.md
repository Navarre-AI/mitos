
## 14 Oct 2026: Express flaw (critical) and friends, fixed from the Pythia session
On Matt's order ("Fix the bugs in all of those projects. Make a note that you did that from here"), from the Pythia session, not this project's own.
- `npm audit fix --omit=dev`, no --force: minor and patch updates in package-lock.json only, no code changed.
- Fixed: proxy-addr (critical: a caller could fake its IP address through IPv4-mapped IPv6 when a trust subnet is set), qs (two moderate: array-limit bypass and a denial of service), body-parser and express (moderate, through qs).
- Not deployed. The running app keeps the old packages until this project's next deploy.
- Not done here: the project's own test suite. Run it before the next deploy.
- Base image: if the Dockerfile says node:20, that line is past end of life (30 Apr 2026). Move to node:26 in this project's own session.

## 14 Oct 2026: Node 26 and DuckDB 1.5.6, in this project's own session
- Dockerfile: node:20-slim (end of life 30 Apr 2026) to node:26-slim; DuckDB CLI 1.5.3 to 1.5.6 (the Dockerfile and scripts/fetch-duckdb.mjs). package.json engines: node >=24.
- Checked on Node 26 with both DuckDB versions on the sample data: eval 28 of 29 at hit@1 and 29 of 29 at hit@3 on each, the same as recorded; check-order PASS. DuckDB 1.5.6 opens an index written by 1.5.3 and answers the same.
- Not deployed.
