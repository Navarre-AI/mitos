# Mitos

**The thread through your database. One field, any table, the right record.**

Search for FileMaker, named for Ariadne's thread: one thin line through a
tangled structure, straight to the thing at the center.

Point Mitos at a FileMaker Server over OData, choose the tables and fields to
search, and give your users a single search field that finds the right record
in any table. Results are balanced across tables: search "Canon" and you get
Canon cameras from Products, Canonical Systems from Companies, and Mary Cannon
from People, without one table drowning out the others.

What it isn't: a chatbot, a report tool, or a replacement for FileMaker. It
keeps a search copy of the fields you pick and hands you back to the real
record. The exact search is deterministic and never waits on a model. The AI
parts are optional extras, each with its own switch.

Sibling of [Pythia](https://github.com/Navarre-AI/pythia) (reports) and
[Clio](https://github.com/Navarre-AI/clio) (logs). Runs in your own cloud
account, on your bill, under your control.

## Quick start

Mac, in Terminal:

```bash
curl -fsSL https://navarre.ai/get/mitos | sh
```

Windows, in PowerShell: `irm https://navarre.ai/get/mitos.ps1 | iex`

It builds Mitos in your own Fly.io account and opens it in your browser. The
setup screens walk you through FileMaker. Then add the kit to your file (three
scripts and a web viewer) so search lives inside your layouts. The full path,
including what to have ready first, is in [INSTALL.md](INSTALL.md).

## The site password

Mitos sits behind one site password (the `SITE_PASSWORD` secret on your Fly
app). Open the bare address and you get a sign-in page; sign in once and a
cookie keeps you in for 30 days. A FileMaker web viewer can't answer a
sign-in page, so it puts the site password in the URL (`?key=...`), which
signs in and lands on the same address without it. It's a different thing
from the API keys of the AI providers. Details in [SECURITY.md](SECURITY.md).

## Your data

- **Stays on your machine.** On your own Fly machine and its volume: a copy
  of the fields you chose, the search index, the vectors (if you switch
  semantic search on), and your settings. There's no Mitos server and no
  telemetry. The one call home: twice a day it reads the public model list at
  navarre.ai/ai-models.json, and sends nothing about you or your data.
- **Leaves, to the AI provider you picked.** Only if you added an API key,
  and only for the stages you switched on. Record text goes out for search
  notes, semantic vectors and the AI best-match pick. Search text goes out for
  the AI stages that read or compare your query. Naming sends table and field
  names, no records. The providers are Anthropic, OpenAI, Google and Voyage,
  each called only with its own key.
- **FileMaker is read-only.** Mitos reads through OData and never writes to
  FileMaker. Give the account a read-only privilege set and the server
  enforces it too.
- **Keys are stored on the Fly volume** (in `config.json`, plain text), along
  with the FileMaker login. Treat the volume like a config file with secrets
  in it.

The table of exactly what is sent, and the honest limits, are in
[SECURITY.md](SECURITY.md).

## The docs

| Doc | For |
|---|---|
| [INSTALL.md](INSTALL.md) | Anyone setting Mitos up: before you install, the install, FileMaker, updating |
| [filemaker/README.md](filemaker/README.md) | The FileMaker developer adding the kit to a file |
| [filemaker/RECORD-UPDATES.md](filemaker/RECORD-UPDATES.md) | Optional: a saved record in search right away |
| [HOW-IT-WORKS.md](HOW-IT-WORKS.md) | Anyone curious how a search is read, the AI stages, indexing |
| [API.md](API.md) | Anyone calling Mitos from a script or a web viewer |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | When something broke: the exact words Mitos prints, and the fix |
| [SECURITY.md](SECURITY.md) | What Mitos stores, who can read it, what leaves and when |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each version |
| [AGENTS.md](AGENTS.md) | An AI agent installing, running, testing or extending Mitos |
| [EXTENDING.md](EXTENDING.md), [GOTCHAS.md](GOTCHAS.md), [RULES.md](RULES.md) | People changing Mitos's code |

## Who built it

Mitos is a human and AI partnership, and proud of it.

- **Matt Navarre**: the idea, the design, every decision, and a lot of testing.
  Forty years of FileMaker and one stubborn belief that search should be one
  field.
- **Claude** (Anthropic), working in Claude Code as Hera: most of the code,
  the reviews and the test runs.
- **Clawdia**: Matt's always-on agent, running Hermes, who tests the builds
  around the clock.
- **Maia**: Matt's OpenAI Codex agent, on the marketing and website side.

## Licence

MIT. See [LICENSE](LICENSE). © 2026 Navarre AI (Fermata Software LLC),
created by Matt Navarre. [navarre.ai](https://navarre.ai)

Stuck? [TROUBLESHOOTING.md](TROUBLESHOOTING.md) ends with a free 15-minute
call.
