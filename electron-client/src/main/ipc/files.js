const { BrowserWindow, dialog, ipcMain, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const axios = require("axios");

const DEFAULT_DOWNLOAD_TIMEOUT = 120000;
const TEMP_SUFFIX = ".downloading";
const downloadTasks = new Map();

function getTask(taskId) {
  const id = String(taskId || "").trim();
  if (!id) return null;
  if (!downloadTasks.has(id)) downloadTasks.set(id, { cancelled: false, abort: null });
  return downloadTasks.get(id);
}

function clearTask(taskId) {
  const id = String(taskId || "").trim();
  if (id) downloadTasks.delete(id);
}

function cancelTask(taskId) {
  const task = downloadTasks.get(String(taskId || "").trim());
  if (!task) return { isSuccess: false, message: "任务不存在或已结束" };
  task.cancelled = true;
  if (task.abort) task.abort();
  return { isSuccess: true };
}

function ensureDir(destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
}

function tempPath(destPath) {
  return `${destPath}${TEMP_SUFFIX}`;
}

async function writeStreamToPath(stream, destPath) {
  ensureDir(destPath);
  const tmp = tempPath(destPath);
  fs.rmSync(tmp, { force: true });
  await pipeline(stream, fs.createWriteStream(tmp));
  fs.rmSync(destPath, { force: true });
  fs.renameSync(tmp, destPath);
}

async function selectDirectoryDialog(event, options = {}) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: "选择保存目录",
    properties: ["openDirectory", "createDirectory"],
    ...options
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true, path: "" };
  return { canceled: false, path: result.filePaths[0] };
}

async function saveBufferToPath(options = {}) {
  const { destPath, buffer } = options;
  if (!destPath) return { isSuccess: false, message: "缺少 destPath" };
  if (buffer == null) return { isSuccess: false, message: "缺少 buffer" };

  try {
    const data = Buffer.isBuffer(buffer)
      ? buffer
      : buffer instanceof Uint8Array
        ? Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        : Buffer.from(buffer);
    ensureDir(destPath);
    const tmp = tempPath(destPath);
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, data);
    fs.rmSync(destPath, { force: true });
    fs.renameSync(tmp, destPath);
    return { isSuccess: true, destPath };
  } catch (error) {
    return { isSuccess: false, message: error.message || "写入失败" };
  }
}

async function getCookieHeader(partition, requestUrl) {
  if (!partition) return "";
  const ses = session.fromPartition(partition);
  const cookies = await ses.cookies.get({ url: requestUrl });
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function downloadFileToPath(options = {}) {
  const {
    url,
    destPath,
    taskId,
    partition,
    headers = {},
    downloadTimeout = DEFAULT_DOWNLOAD_TIMEOUT,
    method = "auto"
  } = options;

  if (!url) return { isSuccess: false, message: "缺少 url" };
  if (!destPath) return { isSuccess: false, message: "缺少 destPath" };

  const task = getTask(taskId);
  const requestHeaders = { ...headers };
  const cookie = await getCookieHeader(partition, url);
  if (cookie) requestHeaders.Cookie = cookie;

  try {
    if (method === "session" && partition) {
      const controller = new AbortController();
      if (task) task.abort = () => controller.abort();
      const timer = setTimeout(() => controller.abort(), downloadTimeout);
      try {
        const response = await session.fromPartition(partition).fetch(url, {
          headers: requestHeaders,
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`);
        await writeStreamToPath(Readable.fromWeb(response.body), destPath);
      } finally {
        clearTimeout(timer);
      }
      return { isSuccess: true, destPath, usedMethod: "session" };
    }

    const controller = new AbortController();
    if (task) task.abort = () => controller.abort();
    const response = await axios.get(url, {
      headers: requestHeaders,
      responseType: "stream",
      timeout: downloadTimeout,
      signal: controller.signal,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 300
    });
    await writeStreamToPath(response.data, destPath);
    return { isSuccess: true, destPath, usedMethod: "headers" };
  } catch (error) {
    if (task && task.cancelled) return { isSuccess: false, message: "cancelled" };
    return { isSuccess: false, message: error.message || "下载失败", status: error.status };
  } finally {
    clearTask(taskId);
  }
}

async function openPathInExplorer(options = {}) {
  const target = String(options.path || "").trim();
  if (!target) return { isSuccess: false, message: "缺少 path" };
  if (!fs.existsSync(target)) return { isSuccess: false, message: "路径不存在" };

  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    const error = await shell.openPath(target);
    return error ? { isSuccess: false, message: error } : { isSuccess: true };
  }
  shell.showItemInFolder(target);
  return { isSuccess: true };
}

function registerUploadHandler() {
  ipcMain.handle("uploadFile", async (_event, args = {}) => {
    const result = { data: null, error: null };
    try {
      let base64 = args.base64Img;
      if (!base64 && args.fileUrl) base64 = await getRemoteBase64(args.fileUrl);
      const file = base64ToFileLike(base64, args.fileName || "file.jpg");
      const form = new FormData();
      form.append(args.formFileName || "file", file);
      for (const [key, value] of Object.entries(args.data || {})) {
        form.append(key, value);
      }
      const response = await axios({
        url: args.url,
        method: args.method || "post",
        headers: args.headers,
        timeout: args.axiosParamsTimeout || 30000,
        data: form
      });
      result.data = response.data;
    } catch (error) {
      result.error = { message: error.message };
      if (error.response) {
        result.error.status = error.response.status || null;
        result.data = error.response.data || null;
      }
    }
    return result;
  });
}

function getRemoteBase64(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function base64ToFileLike(base64, fileName) {
  let data = String(base64 || "");
  let type = "image/jpeg";
  if (data.startsWith("data:")) {
    const comma = data.indexOf(",");
    const header = data.slice(0, comma);
    const match = header.match(/data:([^;]+)/);
    if (match) type = match[1];
    data = data.slice(comma + 1);
  }
  return new File([Buffer.from(data, "base64")], fileName, { type });
}

function registerFileHandlers() {
  registerUploadHandler();
  ipcMain.handle("selectDirectory", (event, args) => selectDirectoryDialog(event, args));
  ipcMain.handle("downloadFileToPath", (_event, args) => downloadFileToPath(args));
  ipcMain.handle("cancelDownloadFileToPath", (_event, args) => cancelTask(args && args.taskId));
  ipcMain.handle("saveBufferToPath", (_event, args) => saveBufferToPath(args));
  ipcMain.handle("openPathInExplorer", (_event, args) => openPathInExplorer(args));
}

module.exports = { registerFileHandlers };

