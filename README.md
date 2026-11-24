# site-generator

A fast, dependency-free reimplementation of the makefun-site 1.0.0 static
site generator. `solve.js` exposes `run(input)`, which returns the exact
output tree (byte for byte) that makefun-site 1.0.0 produces for a site:
every page's `index.html`, the index and tag pages, `build-report.txt`,
and each static file. `main.ts` is the harness driver: it reads all cases
from `/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

![make.fun bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)
![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/sutanvmd/site-generator/rank.svg)
![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/sutanvmd/site-generator/reward.svg)
Bounty: [Build a static site faster, 22 November 2026](https://make.fun/bounty/site-generator-speed-01-run-20261122)

## Licence

MIT
