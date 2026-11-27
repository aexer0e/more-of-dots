// The Leaderboard page: More of Dots' own Leaderboard tab, loaded only when the page
// is opened. It reads the copy of the rankings the share worker keeps for every
// visitor (share/src/leaderboard.js), so visitors never ask the leaderboard service
// themselves.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { LeaderboardApp } from "../leaderboard/App";

let root = null;
export function mount(element) {
  root?.unmount();
  root = createRoot(element);
  root.render(createElement(LeaderboardApp));
}
export function unmount() {
  root?.unmount();
  root = null;
}
