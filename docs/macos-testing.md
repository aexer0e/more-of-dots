# macOS test checklist

More of Dots for macOS has not been tested on a Mac by its developer. Before a release, someone with an Apple silicon Mac and War of Dots installed from Steam should go through this list and send back the answers.

## Install

1. Open the `.dmg` from the draft release, or from the `more-of-dots-macOS` artifact of a pull request's Build run, and drag More of Dots to Applications.
2. Open the app. macOS blocks it the first time because it is not notarized. Open **System Settings > Privacy & Security**, choose **Open Anyway** for More of Dots, and confirm.
3. If macOS reports that the app is damaged, run this in Terminal and open it again:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/More of Dots.app"
   ```

## Where the game keeps its files

The app looks for the game's `replays`, `map_editor`, `assets` and `config.txt` in `~/Library/Application Support/Steam/steamapps/common/War of Dots`, and inside an app bundle there. Send the output of:

```bash
find "$HOME/Library/Application Support/Steam/steamapps/common/War of Dots" -maxdepth 5 \( -name replays -o -name map_editor -o -name assets -o -name config.txt \)
```

```bash
ls "$HOME/Library/Application Support" | grep -i dots
```

## Checks

Note the macOS version and the Mac model, then for each item say whether it works and what went wrong if it did not.

1. **Replays**: the Replays tab lists your replays with map previews.
2. **Playback**: a replay opens in its own window, plays with music and sound effects, and seeking and speed changes work.
3. **Export**: record one replay at 1080p with sound. Note how long it takes and the replay's length. The video plays in QuickTime with sound.
4. **Show in folder**: the folder button on a finished export opens Finder with the video selected.
5. **Download**: saving one replay and several replays opens the save and folder dialogs and writes the files.
6. **Leaderboard**: your username is found and highlighted.
7. **Map editor**: your maps are listed, and saving a draft and saving to the game both work.
8. **Region**: the tab is greyed out, and hovering it says it is only available on Windows.
9. **Updates**: clicking the version number checks for updates without an error.
