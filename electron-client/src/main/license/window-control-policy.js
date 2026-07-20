const MAIN_WINDOW_ONLY_CHANNELS = new Set([
  "getMainWindowInfo",
  "reloadHomeUrl",
  "resetMainWindow",
  "minimizeWindow",
  "maximizeWindow",
  "closeWindow",
  "isWindowMaximized"
]);

function mainWindowControlDecision(role, channel) {
  if (!MAIN_WINDOW_ONLY_CHANNELS.has(channel)) return null;
  return role === "main";
}

module.exports = {
  MAIN_WINDOW_ONLY_CHANNELS,
  mainWindowControlDecision
};
