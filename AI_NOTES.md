# AI notes

## Tools used

**Claude Code** (Anthropic's CLI agent, Claude Opus model), for most of the implementation: the backend, tests, Docker setup, the React screen and first drafts of the README and these notes. It also ran the commands: installing packages, starting Postgres in Docker, running the tests and smoke-testing the flow with `curl` and the webhook script.

## A prompt that worked well

I gave it the full brief as written, unedited, rather than splitting it into small tasks. Because it had the whole picture, including "what we look at, in order of importance", it built the hard parts first. Before writing code it reasoned through how order creation, hold expiry and late payments interact under row locks. One example: the webhook takes the same product locks as order creation, so "is this hold still valid?" can't be answered while someone else is taking the same units.

Once the tests passed, it checked that they could fail. It broke the code on purpose and re-ran them. With the product `FOR UPDATE` removed, all 10 racing orders succeeded for 2 units. With the pickup guard loosened, both lockers got `200`. Concurrency tests that pass on the first run don't prove much without that step.

## What the AI got wrong, and how I noticed

- **Slow test reset.** It reset the database between tests with `TRUNCATE … RESTART IDENTITY`. The suite passed but took 160s, and even trivial tests took ~2s each. Its first guess at the cause was wrong: it thought Windows was resolving `localhost` to IPv6 first. Timing a raw connection disproved that (~60ms). Timing the statements found the real cause: on Docker Desktop for Windows, `TRUNCATE` took ~1.3s (it creates and fsyncs new relation files) against ~13ms for `DELETE` on these tiny tables. After switching, the suite took ~50s.
