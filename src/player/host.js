import { convertFileSrc, invoke as nativeInvoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

// The desktop app answers the player's commands in Rust. In a browser the same
// commands are answered by the WebAssembly build of the engine.
const web = isTauri() ? null : import("./web-host.js");
export const invoke = web
  ? async (command, args) => (await web).invoke(command, args)
  : nativeInvoke;

/// `{ files: { music, fighting, … } | null, music, sfx }` with playable URLs.
export async function gameAudio() {
  if (web) return (await web).gameAudio();
  const game = await nativeInvoke("game_audio");
  if (game.files)
    game.files = Object.fromEntries(
      Object.entries(game.files).map(([name, path]) => [name, convertFileSrc(path)]),
    );
  return game;
}

/// Asks for a replay and returns the path to open, or null.
export async function chooseReplay() {
  if (web) return (await web).chooseReplay();
  const path = await open({
    multiple: false,
    filters: [
      { name: "War of Dots replay", extensions: ["rep", "repsim", "jsonl"] },
    ],
  });
  return typeof path === "string" ? path : null;
}

/// Makes a dropped or picked browser file openable by path.
export async function addFile(file) {
  return (await web).addFile(file);
}
