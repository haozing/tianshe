const { registerAppInfoHandlers } = require("./app-info");
const { registerCookieHandlers } = require("./cookies");
const { registerHttpHandlers } = require("./http");
const { registerWindowHandlers } = require("./windows");
const { registerNotificationHandlers } = require("./notifications");
const { registerFileHandlers } = require("./files");
const { registerPartitionHandlers } = require("./partitions");
const { registerLogHandlers } = require("./logs");
const { registerUpdateHandlers } = require("./updates");

function registerIpcHandlers(context) {
  registerAppInfoHandlers(context);
  registerCookieHandlers(context);
  registerHttpHandlers(context);
  registerWindowHandlers(context);
  registerNotificationHandlers(context);
  registerFileHandlers(context);
  registerPartitionHandlers(context);
  registerLogHandlers(context);
  registerUpdateHandlers(context);
}

module.exports = { registerIpcHandlers };
