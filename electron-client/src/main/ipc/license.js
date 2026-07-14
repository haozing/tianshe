const { ipcMain } = require("electron");
const {
  checkLicense,
  clearLocalLicenseState,
  getLicenseStatus,
  redeemLicense
} = require("../license/device-license");

function registerLicenseHandlers() {
  ipcMain.handle("native:license:getStatus", async (_event, args = {}) => getLicenseStatus(args));
  ipcMain.handle("native:license:check", async (_event, args = {}) => checkLicense(args));
  ipcMain.handle("native:license:redeem", async (_event, args = {}) => redeemLicense(args));
  ipcMain.handle("native:license:clearLocal", async () => clearLocalLicenseState());
}

module.exports = { registerLicenseHandlers };
