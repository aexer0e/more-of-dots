export type CardDetails = {
  /** One name per side, teammates joined with " & ". */
  players: string[];
  frames: number;
  version?: string | null;
  /** The map picture, as a URL the page may draw from. */
  picture?: string | null;
};

/** A JPEG of a shared replay's link preview. `base` is where the site's og/ fonts are. */
export function drawCard(details: CardDetails, base: string): Promise<Blob>;
