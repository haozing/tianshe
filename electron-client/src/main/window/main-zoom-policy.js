const MAIN_ZOOM_FACTORS = new Set([1, 1.1, 1.25]);

function mainWindowZoomError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function applyMainWindowZoom({ window, sender, args = {} }) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed() || sender !== window.webContents) {
    throw mainWindowZoomError("MAIN_WINDOW_REQUIRED", "只有当前主窗口可以调整页面缩放");
  }

  const factor = args && args.factor;
  if (typeof factor !== "number" || !Number.isFinite(factor) || !MAIN_ZOOM_FACTORS.has(factor)) {
    throw mainWindowZoomError("ZOOM_FACTOR_INVALID", "页面缩放比例不受支持");
  }

  try {
    sender.setZoomFactor(factor);
    return { ok: true, factor };
  } catch (error) {
    return {
      ok: false,
      factor,
      message: error && error.message ? error.message : "主窗口缩放失败"
    };
  }
}

module.exports = {
  MAIN_ZOOM_FACTORS,
  applyMainWindowZoom
};
