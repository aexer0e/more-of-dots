export type CardDetails = {
  /** One name per side, teammates joined with " & ". */
  players: string[];
  frames: number;
  version?: string | null;
  /** The map picture, as a URL the page may draw from. */
  picture?: string | null;
  /** Each side's troops over the match, drawn as lines over the map. */
  troops?: number[][] | null;
};

/** The current card design; replays shared with an older one are drawn again. */
export const CARD_VERSION: number;

/** A JPEG of a shared replay's link preview. `base` is where the site's og/ fonts are. */
export function drawCard(details: CardDetails, base: string): Promise<Blob>;
