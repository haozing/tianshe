const { ipcMain } = require("electron");
const {
  checkLicense,
  clearLocalLicenseState,
  getLicenseStatus,
  redeemLicense
} = require("../license/device-license");
const { notifyOpportunityHistoryPrewarm, nudgeOpportunitySubmitRecovery } = require("../tasks/task-manager");

async function withRecoveryNudge(action, args) {
  const result = await action(args);
  if (result?.paidAccessGranted === true) {
    await nudgeOpportunitySubmitRecovery(["authorization_wait"], {
      recoverySource: "paid-authorization-restored"
    });
    notifyOpportunityHistoryPrewarm("paid-authorization-restored");
  }
  return result;
}

function registerLicenseHandlers() {
  ipcMain.handle("native:license:getStatus", async (_event, args = {}) => args.refresh
    ? withRecoveryNudge(getLicenseStatus, args)
    : getLicenseStatus(args));
  ipcMain.handle("native:license:check", async (_event, args = {}) => withRecoveryNudge(checkLicense, args));
  ipcMain.handle("native:license:redeem", async (_event, args = {}) => withRecoveryNudge(redeemLicense, args));
  ipcMain.handle("native:license:clearLocal", async () => clearLocalLicenseState());
}

module.exports = { registerLicenseHandlers };
