# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rixo389/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rixo389/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is a command-line patch tool, written in TypeScript (Node 22, standard library only). Run it as `node main.ts [options] [PATCH]` with the working directory as the root of a tree of text files.

It reads a patch in one of four formats — unified diff, SEARCH/REPLACE blocks, V4A, JSON edits — finds the lines each edit names at the first of three matching tiers, and writes every change or none, printing what it changed or why it failed.

Practice score: **100/100** (unified 30/30, search_replace 20/20, v4a 20/20, json 15/15, cli 15/15), verified locally against the kit's 100 practice checks.
