export function eloWinGain(playerRating: number, opponentRating: number) {
  const expectedScore = 1 / (1 + 10 ** ((opponentRating - playerRating) / 400));
  return Math.max(1, Math.min(15, Math.round(16 * (1 - expectedScore))));
}
