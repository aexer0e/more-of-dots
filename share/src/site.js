// Serves the hosted site's pages at their paths, each with the link preview chat
// apps read: the site's page from GitHub Pages with a <base> naming the site's
// folder, its title, and Open Graph tags. A tournament page's tags come from
// og/pages.json, which the site build writes with the card pictures
// (scripts/og-cards.mjs); a shared replay's are read from the replay, and its card
// is the one the sharer's browser drew. Every other request passes through.
// SITE_ORIGIN, when set, is where the site is served from instead, for testing.
import { details, replayText } from "./replay.js";

export const SITE = "/wod-replay-player";
const NAME = "War of Dots Replays";
const HOME = { title: NAME, description: "Watch War of Dots replays in the browser." };
// The site's files, as opposed to its pages.
const FILES = /^(assets|engine|maps|tournaments|audio|og)\/|\.[a-z0-9]+$/i;
const ID = /^[0-9a-f]{16}$/;

const escape = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const clock = (frames) => {
  const s = Math.floor(frames / 30);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// og/pages.json, checked again every five minutes.
let index = null,
  indexAt = 0;
function pageIndex(origin) {
  if (!index || Date.now() - indexAt > 300_000) {
    indexAt = Date.now();
    index = fetch(`${origin}${SITE}/og/pages.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((data) => data ?? { pages: {}, aliases: {} });
  }
  return index;
}

async function sharedPreview(env, id) {
  const row = await env.DB.prepare("SELECT players, frames, version, card IS NOT NULL AS card FROM replays WHERE id = ?").bind(id).first();
  if (!row) return null;
  let { players, frames, version } = row;
  // Replays shared before previews are described once, on their first preview.
  if (players === null) {
    const { data } = await env.DB.prepare("SELECT data FROM replays WHERE id = ?").bind(id).first();
    const text = await replayText(new Uint8Array(data));
    ({ players, frames, version } = details(text ?? ""));
    players = JSON.stringify(players);
    await env.DB.prepare("UPDATE replays SET players = ?, frames = ?, version = ? WHERE id = ?").bind(players, frames, version, id).run();
  }
  const names = JSON.parse(players);
  const facts = [frames ? clock(frames) : null, version ? `v${version}` : null].filter(Boolean).join(" · ");
  return {
    title: names.length ? names.join(" vs ") : "A shared replay",
    description: row.card || !facts ? `Shared on ${NAME}` : facts,
    image: row.card ? `og/r/${id}.jpg` : null,
  };
}

async function previewFor(url, origin, path, env) {
  const parts = path.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  if (parts[0] === "r" && ID.test(parts[1] ?? "")) return (await sharedPreview(env, parts[1])) ?? HOME;
  const { pages, aliases } = await pageIndex(origin);
  if (parts.length && aliases[parts[0]]) parts[0] = aliases[parts[0]];
  return pages[parts.join("/")] ?? HOME;
}

function withPreview(page, preview, url) {
  const image = preview.image ? `${url.origin}${SITE}/${preview.image}` : null;
  const meta = (attribute, name, content) => `<meta ${attribute}="${name}" content="${escape(content)}">`;
  const tags = [
    meta("property", "og:site_name", NAME),
    meta("property", "og:type", "website"),
    meta("property", "og:title", preview.title),
    meta("property", "og:description", preview.description),
    meta("property", "og:url", `${url.origin}${url.pathname}${url.search}`),
    meta("name", "theme-color", "#5a92c4"),
    meta("name", "twitter:card", image ? "summary_large_image" : "summary"),
    ...(image
      ? [meta("property", "og:image", image), meta("property", "og:image:width", "1200"), meta("property", "og:image:height", "630"), meta("name", "twitter:image", image)]
      : []),
  ].join("");
  const transformed = new HTMLRewriter()
    .on("head", {
      element(head) {
        head.prepend(`<base href="${SITE}/">`, { html: true });
        head.append(tags, { html: true });
      },
    })
    .on("title", { element: (title) => title.setInnerContent(preview.title === NAME ? NAME : `${preview.title} · ${NAME}`) })
    .on('meta[name="description"]', { element: (tag) => tag.setAttribute("content", preview.description) })
    .transform(page);
  const headers = new Headers(transformed.headers);
  headers.set("Cache-Control", "public, max-age=60");
  return new Response(transformed.body, { status: 200, headers });
}

export async function site(request, env) {
  const url = new URL(request.url);
  const origin = env.SITE_ORIGIN ?? url.origin;
  const pass = () => (env.SITE_ORIGIN ? fetch(new Request(`${origin}${url.pathname}${url.search}`, request)) : fetch(request));
  if (url.pathname === SITE) return Response.redirect(`${url.origin}${SITE}/${url.search}`, 301);
  const path = url.pathname.slice(SITE.length + 1);
  const card = /^og\/r\/([0-9a-f]{16})\.jpg$/.exec(path);
  if (card) {
    const row = await env.DB.prepare("SELECT card FROM replays WHERE id = ? AND card IS NOT NULL").bind(card[1]).first();
    return row
      ? new Response(new Uint8Array(row.card), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } })
      : new Response("Not found", { status: 404 });
  }
  if ((request.method !== "GET" && request.method !== "HEAD") || FILES.test(path)) return pass();
  // The play page (play?room=1234) is its own file.
  if (path === "play") return fetch(new Request(`${origin}${SITE}/play.html${url.search}`, request));
  // Requests from this worker to its own site reach GitHub Pages, not the worker again.
  const page = await fetch(`${origin}${SITE}/`);
  if (!page.ok) return page;
  let preview = HOME;
  try {
    preview = await previewFor(url, origin, path, env);
  } catch (error) {
    console.error(error);
  }
  return withPreview(page, preview, url);
}
