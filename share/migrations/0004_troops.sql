-- Each side's troops over the match, for the lines on a replay's card: up to 30
-- values a side, as JSON. Sent by the browser or app that shared the replay, or
-- filled in by scripts/troops.mjs, so visitors never simulate a replay for its card.
ALTER TABLE replays ADD COLUMN troops TEXT;
