// Old player deep links use the same independent entry as new library windows.
if (new URLSearchParams(location.search).get("mode") === "player") {
  location.replace(`player.html${location.search}`);
} else {
  void import("./main");
}
