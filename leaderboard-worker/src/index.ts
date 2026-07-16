export interface Env {
  DB: D1Database;
  CLAIM_PEPPER?: string;
}

type SnapshotRequest = {
  player?: {
    username?: unknown;
    normalizedUsername?: unknown;
    score?: unknown;
    officialRank?: unknown;
    games?: unknown;
    wins?: unknown;
    losses?: unknown;
    region?: unknown;
    source?: unknown;
    fetchedAt?: unknown;
  };
  claimToken?: unknown;
  client?: {
    version?: unknown;
  };
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders,
      ...init.headers,
    },
  });
}

function normalizeUsername(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "");
}

function boundedString(value: unknown, max = 80): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.slice(0, max);
}

function optionalInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function requiredInteger(value: unknown, name: string): number {
  const number = optionalInteger(value);
  if (number === null) throw new Error(`${name} is required.`);
  return number;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function tokenVerifier(token: string, env: Env): Promise<string> {
  return sha256Hex(`more-of-dots-worker-v1\0${env.CLAIM_PEPPER ?? ""}\0${token}`);
}

async function leaderboard(request: Request, env: Env) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(optionalInteger(url.searchParams.get("limit")) ?? 100, 1), 250);
  const offset = Math.max(optionalInteger(url.searchParams.get("offset")) ?? 0, 0);
  const region = boundedString(url.searchParams.get("region"), 16);
  const where = region ? "WHERE region = ?1" : "";
  const params = region ? [region, limit, offset] : [limit, offset];
  const rows = await env.DB.prepare(
    `
      SELECT
        username,
        normalized_username AS normalizedUsername,
        score,
        official_rank AS officialRank,
        games,
        wins,
        losses,
        region,
        updated_at AS updatedAt,
        official_rank AS rank
      FROM players
      ${where}
      ORDER BY official_rank IS NULL, official_rank ASC, score DESC, updated_at ASC
      LIMIT ?${region ? 2 : 1}
      OFFSET ?${region ? 3 : 2}
    `,
  )
    .bind(...params)
    .all();

  return jsonResponse({ configured: true, rows: rows.results ?? [] });
}

async function submitSnapshot(request: Request, env: Env) {
  const body = (await request.json().catch(() => null)) as SnapshotRequest | null;
  const player = body?.player;
  const username = boundedString(player?.username);
  const normalizedUsername = normalizeUsername(player?.normalizedUsername || username);
  const claimToken = boundedString(body?.claimToken, 128);
  if (!username || !normalizedUsername || !claimToken) {
    return jsonResponse({ error: "username and claimToken are required." }, { status: 400 });
  }

  const score = requiredInteger(player?.score, "score");
  const now = Math.floor(Date.now() / 1000);
  const fetchedAt = optionalInteger(player?.fetchedAt) ?? now;
  const officialRank = optionalInteger(player?.officialRank);
  const games = optionalInteger(player?.games);
  const wins = optionalInteger(player?.wins);
  const losses = optionalInteger(player?.losses);
  const region = boundedString(player?.region, 16);
  const source = boundedString(player?.source, 48);
  const clientVersion = boundedString(body?.client?.version, 32);
  const verifier = await tokenVerifier(claimToken, env);

  const existing = await env.DB.prepare(
    "SELECT token_verifier AS tokenVerifier FROM players WHERE normalized_username = ?1",
  )
    .bind(normalizedUsername)
    .first<{ tokenVerifier: string }>();
  if (existing && existing.tokenVerifier !== verifier) {
    return jsonResponse(
      {
        error:
          "This player name is active elsewhere. War of Dots is probably still running in another installation or session. Close the other game, then try again.",
      },
      { status: 409 },
    );
  }

  const latestSnapshot = await env.DB.prepare(
    "SELECT score, submitted_at AS submittedAt FROM snapshots WHERE normalized_username = ?1 ORDER BY submitted_at DESC LIMIT 1",
  )
    .bind(normalizedUsername)
    .first<{ score: number; submittedAt: number }>();
  const shouldRecordSnapshot = !(latestSnapshot && latestSnapshot.score === score && now - latestSnapshot.submittedAt < 60);

  if (!shouldRecordSnapshot) {
    await env.DB.prepare(
      `
        INSERT INTO players (
          normalized_username, username, token_verifier, score, official_rank, games, wins,
          losses, region, source, first_seen, updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(normalized_username) DO UPDATE SET
          username = excluded.username,
          score = excluded.score,
          official_rank = excluded.official_rank,
          games = excluded.games,
          wins = excluded.wins,
          losses = excluded.losses,
          region = excluded.region,
          source = excluded.source,
          updated_at = excluded.updated_at
      `,
    ).bind(normalizedUsername, username, verifier, score, officialRank, games, wins, losses, region, source, now, now).run();

    return jsonResponse({
      ok: true,
      throttled: true,
      message: "Recent identical snapshot already recorded.",
      rank: officialRank,
      score,
      player: {
        username,
        normalizedUsername,
        score,
        officialRank,
        games,
        wins,
        losses,
        region,
        updatedAt: now,
        rank: officialRank,
      },
    });
  }

  await env.DB.batch([
    env.DB.prepare(
      `
        INSERT INTO players (
          normalized_username, username, token_verifier, score, official_rank, games, wins,
          losses, region, source, first_seen, updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(normalized_username) DO UPDATE SET
          username = excluded.username,
          score = excluded.score,
          official_rank = excluded.official_rank,
          games = excluded.games,
          wins = excluded.wins,
          losses = excluded.losses,
          region = excluded.region,
          source = excluded.source,
          updated_at = excluded.updated_at
      `,
    ).bind(normalizedUsername, username, verifier, score, officialRank, games, wins, losses, region, source, now, now),
    env.DB.prepare(
      `
        INSERT INTO snapshots (
          normalized_username, username, score, official_rank, games, wins, losses,
          region, source, fetched_at, submitted_at, client_version
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
      `,
    ).bind(normalizedUsername, username, score, officialRank, games, wins, losses, region, source, fetchedAt, now, clientVersion),
  ]);

  return jsonResponse({
    ok: true,
    rank: officialRank,
    score,
    player: {
      username,
      normalizedUsername,
      score,
      officialRank,
      games,
      wins,
      losses,
      region,
      updatedAt: now,
      rank: officialRank,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "GET" && url.pathname === "/leaderboard") {
        return leaderboard(request, env);
      }
      if (request.method === "POST" && url.pathname === "/snapshot") {
        return submitSnapshot(request, env);
      }
      return jsonResponse({ error: "Not found." }, { status: 404 });
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : "Unexpected error." }, { status: 500 });
    }
  },
};
