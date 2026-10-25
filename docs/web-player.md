# Hosted replay player

The desktop replay player also runs as a static site, published from `aexer0e/wod-replay-player` to https://aexer0e.dev/wod-replay-player/. It uses the same player code and the same simulation engine as the desktop app.

## One source of truth

All code lives in this repository. The site repository holds a deploy workflow, a README and the game's sound files. On each deploy it checks out this repository, compiles `engine/repsim` to WebAssembly, builds the player page and publishes the result to GitHub Pages. No build output is committed anywhere.

## Parts

| Path | Role |
|---|---|
| `engine/web/ReplaySim.Web.csproj` | Compiles the `engine/repsim` sources for `browser-wasm`, without the Skia renderer, its text and video export |
| `engine/web/Exports.cs` | `Open`, `AddMap` and `Run`, the entry points called from JavaScript |
| `src/player/host.js` | Chooses the backend: Tauri commands on the desktop, `web-host.js` in a browser |
| `src/player/web-host.js` | Answers `open_replay`, `replay_progress` and `replay_chunk` in the browser and keeps the engine's chunks in memory |
| `src/player/web-engine.js` | Worker that runs the WebAssembly engine and posts its chunks |
| `site.html`, `vite.site.config.ts` | The site's page and its Vite build |
| `src/site/main.js` | The site's pages around the player: home, tournament brackets and replays, and the routes that link to them |
| `src/site/library.js` | Replays a visitor adds, kept in the browser's IndexedDB |
| `src/site/share.js` | Uploads, opens and stops sharing replays through the share worker, and downloads replay links |
| `share/` | The `wod-replays` Cloudflare Worker that keeps shared replays in D1 |
| `src/site/bracket.js` | Lays out a Challonge double elimination bracket |
| `scripts/build-site.mjs` | Builds everything into `build/site` |
| `scripts/tournaments.mjs` | Publishes the tournament folders from the site repository |
| `.github/workflows/notify-site.yml` | Asks the site repository to rebuild when `VERSION` changes |

The engine sources carry three `#if BROWSER` guards in `Program.cs`. Everything else in `engine/repsim` is compiled unchanged.

## How the browser backend differs

- **Simulation** runs in a worker. It is one long synchronous call, so opening another replay terminates the worker and starts a new one.
- **Frames** arrive as compressed chunks, the same stream the desktop player reads from the engine's standard output ([replay frame chunks](replay-frames.md)). The page keeps them as they are and the render worker decompresses one chunk at a time.
- **Official maps** are published under `maps/` and fetched only when a replay names one. Replays with an embedded map need nothing. The engine bundles 105 of them; the site repository adds the rest of the game's maps with `--maps`, laid out as in the game folder. `maps/index.json` lists every published map, so a replay card can show the map a replay names: by its image path, or by number in the Fahero, Zolamare and Eronion sets, as More of Dots looks them up in the game.
- **Player names** are drawn on a canvas by `web-host.js`, because the desktop engine renders them with Skia. They can differ by a pixel from the desktop labels.
- **Sound** is served from `audio/` in the site repository. A build without those files plays silently.
- **Not available**: video export, reference snapshots and the QA capture options, which use the native renderer.

## Pages and links

Every page has its own address under the site's folder, so any view can be shared:

| Address | Page |
|---|---|
| `/wod-replay-player/` | Home: drop a .rep, the visitor's replays, and the tournaments |
| `gt3` | A tournament's bracket |
| `gt3/105` | The bracket with match 105's replays open |
| `gt3/replays` | Every replay of a tournament, grouped by match |
| `gt3/105/6-city` | Watch the 6 City game of match 105 |
| `mine/<id>` | Watch a replay kept in this browser. It only works on the device that added it. |
| `r/<id>` | Watch a shared replay. It works on any device. |
| `s?=<link>` | Watch the replay at a link, such as a Discord attachment. The link may be percent-encoded. |

Earlier links put the same paths after `#/`, as in `/wod-replay-player/#/gt3/105`. They still open, and the address changes to the path once the page loads. The site moves between pages with the browser's history, so Back and Forward work as on any site.

GitHub Pages serves only the site's files, so the share Worker serves its pages (below). Should a path reach GitHub Pages anyway, its `404.html` opens the same page by its `#/` address. `src/site/base.js` names the site's folder in a `<base>` when the page has none, so the site's files load from any page.

The player shows only on the watch pages. The site sets hooks on `embedding` in `src/player/main.js`. While another page shows, the player ignores its keyboard shortcuts and file drops. Files dropped on any page are kept in the visitor's library. The player's back button returns to the page the visitor came from.

Replays a visitor adds stay in the browser unless they share one. They are stored in IndexedDB under the start of their SHA-256, so adding the same file twice keeps one copy.

## Link previews

Chat apps such as Discord show a preview of a link from tags in the page's HTML, and they never send the part of an address after a `#`. So the `wod-replays` Worker is routed at `aexer0e.dev/wod-replay-player*`: it serves each page as the site's `index.html` from GitHub Pages with a `<base>` naming the site's folder, the page's title, and Open Graph tags. Requests for the site's files pass through to GitHub Pages.

| Page | Preview |
|---|---|
| A tournament game | `<players> · <map>` and the tournament, with a card: the map, the players in their colours, the map, length and round |
| A match | `<winner> <score> <loser>` and its round, with a card of its maps and lengths when it has replays |
| A tournament | Its name, when it ran and its number of replays, no picture |
| Its replays page | Its name and number of replays, no picture |
| A shared replay | Its players and length, with the card its sharer's browser drew |
| Anything else | The site's name and description, no picture |

The site build writes `og/pages.json`, the title and description of every tournament page, and the tournament cards under `og/`, with `scripts/og-cards.mjs` (satori lays them out, resvg draws them). A tournament's aliases are listed there too. A shared replay's preview is read from the replay when it is shared; replays shared before previews are read on their first preview. Its card is drawn by `src/site/card.js` in the sharer's browser, in the same layout and font (Inter, under the SIL Open Font License in `scripts/og/OFL.txt`), and uploaded after the replay.

Chat apps keep a link's preview for a while, so a changed page can show its old preview in a link posted before.

## Sharing

The link button on a replay card uploads the replay and copies its `r/<id>` link. The id is the same as in the library, so sharing a file twice gives the same link. A shared replay's card keeps the button in view, and clicking it again copies the link without uploading.

The upload goes to the `wod-replays` Worker at https://wod-replays.moreofdots.workers.dev, which stores the file in the `wod-replays` D1 database:

| Request | Result |
|---|---|
| `POST /replays` with the file as the body | `{ id, token }`. `token` is missing when the file was already shared. |
| `GET /replays/<id>` | The file, or 404 when it is no longer shared |
| `PUT /replays/<id>/card` with `Authorization: Bearer <token>` and a JPEG body | Adds the picture its link preview shows |
| `DELETE /replays/<id>` with `Authorization: Bearer <token>` | Stops sharing it |
| `GET /fetch?url=<link>` | The replay at any link |

The Worker accepts and downloads files up to 1 MB that are a gzip or plain JSON replay with a map, cards up to 512 KB, and 10 uploads a minute from one address. Only `https://aexer0e.dev` and local addresses may call it from a page.

## Opening links

The home page opens a replay from a link typed into the drop area, or pasted anywhere outside a field, and `s?=<link>` opens one from an address. Pasted files are kept like dropped ones. Most sites, Discord included, do not let other pages read their files, so the Worker downloads every link. It stops reading past 1 MB and returns the file only when it is a replay, so it cannot be used to download anything else.

Discord attachment links stop working about a day after they are copied, so an `s?=` link to one does too. A shared `r/` link lasts.

The browser that shared a replay keeps its token. Removing the replay there also stops sharing it. Opening a shared link keeps the replay in the viewer's library, without a token.

Shared replays are kept until the sharer removes them. D1's free plan holds 5 GB, about 130,000 replays of the usual size.

To change the Worker, run these in `share/`:

```bash
npm install
npm run migrate -- --remote
npm run deploy
```

`npm run migrate` applies the database changes under `share/migrations`. To try the site and Worker together locally, build the site with `VITE_SHARE_API=http://localhost:8787`, serve `build/site` at `/wod-replay-player/` (the `site-files` preview, from `build/preview`), apply the migrations with `--local`, and run the Worker with `npm run dev -- --port 8787 --var SITE_ORIGIN:http://127.0.0.1:4174` (the `site-pages` preview). Then open `http://localhost:8787/wod-replay-player/`.

## Tournaments

Tournaments live in the site repository under `tournaments/<id>/`: the tournament's `.rep` files and a hand-written `tournament.json`. That file holds:
- the name, format, and start and end dates (`started`, `ended`)
- the final results
- every player with their bracket name and seed, plus their in-game `username` when it is known
- every match copied from Challonge
- optionally, `aliases`: earlier names of the folder. Links that use one open the same page, and the address changes to the current name.

The build assigns each replay to the match its two players played, matching the replay's usernames to the players' `username` fields. A replay whose players met more than once, such as a grand final and its reset, names its match in an optional `"replays": { "file.rep": 113 }` object. The build stops with a message when a replay's players are unknown or its match is ambiguous.

Map names come from the number of cities: 12 cities is "6 City". The order the games of a match were played in is not recorded, so a match lists its replays by map.

Pages show bracket names. When a player's in-game username is known and differs, it follows in brackets, as in `samuel i (clunch)`.

## Building locally

Requires .NET SDK 9 with the `wasm-tools` workload (`dotnet workload install wasm-tools`).

```bash
npm run build:site
```

The output is `build/site`. Pass `-- --audio <folder>` to include sound files, `-- --maps <folder>` to include the game's map images, `-- --tournaments <folder>` to publish tournaments, and `-- --skip-engine` to reuse the last engine build. Set `DOTNET` to use a specific `dotnet` executable.

## Checking parity

`scripts/web-engine.mjs` runs the WebAssembly engine under Node and writes its JSONL output as a `.repsim`. `scripts/compare-web-engine.mjs` compares two `.repsim` files record by record.

On 8 October 2026, 11 replays from 1,095 to 43,350 ticks produced output identical to the desktop engine in every frame. All 11 were version 1.4.1 experiment-mode replays; other modes and older versions have not been compared yet.

On 20 October 2026 the WebAssembly engine simulated a 43,350-tick replay in 24.7 s under Node, about 1,750 ticks per second, against 7.9 s for the desktop engine. Before the frame chunks and territory caches it managed 250 to 300 ticks per second. Playback starts after the first frame, about two seconds after opening.

## Deployment

`notify-site.yml` runs on a push to `main` that changes `VERSION` and sends a `repository_dispatch` event to the site repository. It needs the secret `SITE_DISPATCH_TOKEN`: a fine-grained personal access token limited to `aexer0e/wod-replay-player` with read and write access to Contents.

The site repository's **Deploy site** workflow can also be run by hand against any branch, tag or commit of this repository. The published `version.json` records the version and commit that were built.
