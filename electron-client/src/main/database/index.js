const path = require("node:path");
const { Worker } = require("node:worker_threads");
const {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  MAX_QUEUE_DEPTH,
  createError,
  estimateMessageBytes,
  normalizePriority
} = require("./protocol");

class NativeDataService {
  constructor({ app }) {
    this.app = app;
    this.worker = null;
    this.workerGeneration = 0;
    this.databasePath = path.join(app.getPath("userData"), "data", "chihu-business.sqlite3");
    this.workerPath = path.join(__dirname, "worker.js");
    this.nextRequestId = 1;
    this.pending = new Map();
    this.queue = [];
    this.inFlight = false;
    this.startPromise = null;
    this.stopping = false;
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.startPromise = this.createWorker()
      .then(() => this.sendImmediate("initialize", { databasePath: this.databasePath }, { timeoutMs: 30000 }))
      .catch((error) => {
        this.startPromise = null;
        this.destroyWorker();
        throw error;
      });
    return this.startPromise;
  }

  async stop() {
    this.stopping = true;
    try {
      if (this.worker) {
        await this.sendImmediate("maintenance.close", {}, { timeoutMs: 3000 }).catch(() => null);
      }
    } finally {
      this.rejectAll(createError("NATIVE_DATA_STOPPED", "Native data service stopped"));
      this.destroyWorker();
      this.startPromise = null;
    }
  }

  async request(method, args = {}, options = {}) {
    if (this.stopping) throw createError("NATIVE_DATA_STOPPING", "Native data service is stopping");
    await this.start();
    return this.enqueue(method, args, options);
  }

  createWorker() {
    if (this.worker) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerPath, {
        workerData: { databasePath: this.databasePath }
      });
      this.worker = worker;
      this.workerGeneration += 1;
      let settled = false;

      const onOnline = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const onInitialError = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      worker.once("online", onOnline);
      worker.once("error", onInitialError);
      worker.on("message", (message) => this.handleWorkerMessage(message));
      worker.on("error", (error) => this.handleWorkerFailure(error));
      worker.on("exit", (code) => {
        if (this.worker === worker) {
          this.worker = null;
          this.startPromise = null;
          this.inFlight = false;
        }
        if (!this.stopping && code !== 0) {
          this.rejectAll(createError("NATIVE_DATA_WORKER_EXITED", `Native data worker exited with code ${code}`));
        }
      });
    });
  }

  destroyWorker() {
    const worker = this.worker;
    this.worker = null;
    this.inFlight = false;
    if (worker) worker.terminate().catch(() => null);
  }

  enqueue(method, args, options = {}) {
    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      throw createError("NATIVE_DATA_QUEUE_FULL", "Native data queue is full", { maxQueueDepth: MAX_QUEUE_DEPTH });
    }
    this.validateMessage(method, args);

    const request = this.createRequest(method, args, options);
    request.priority = normalizePriority(options.priority);
    this.queue.push(request);
    this.queue.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
    this.drain();
    return request.promise;
  }

  sendImmediate(method, args, options = {}) {
    this.validateMessage(method, args);
    const request = this.createRequest(method, args, options);
    this.dispatch(request);
    return request.promise;
  }

  createRequest(method, args, options = {}) {
    const id = `${Date.now()}-${this.nextRequestId++}`;
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS));
    const createdAt = Date.now();
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const request = {
      id,
      method,
      args,
      createdAt,
      resolve: resolvePromise,
      reject: rejectPromise,
      promise,
      dispatched: false,
      timer: null
    };
    request.timer = setTimeout(() => {
      this.removeQueued(id);
      this.pending.delete(id);
      request.reject(createError("NATIVE_DATA_TIMEOUT", `Native data request timed out: ${method}`, { timeoutMs }));
      this.drain();
    }, timeoutMs);
    return request;
  }

  validateMessage(method, args) {
    if (!method || typeof method !== "string") throw createError("NATIVE_DATA_BAD_METHOD", "Invalid native data method");
    const size = estimateMessageBytes({ method, args });
    if (size > MAX_MESSAGE_BYTES) {
      throw createError("NATIVE_DATA_MESSAGE_TOO_LARGE", "Native data message is too large", { size, max: MAX_MESSAGE_BYTES });
    }
  }

  removeQueued(id) {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index >= 0) this.queue.splice(index, 1);
  }

  dispatch(request) {
    if (!this.worker) {
      request.reject(createError("NATIVE_DATA_NOT_READY", "Native data worker is not ready"));
      return;
    }
    request.dispatched = true;
    this.pending.set(request.id, request);
    this.worker.postMessage({ type: "request", id: request.id, method: request.method, args: request.args });
  }

  drain() {
    if (this.inFlight || !this.worker || !this.queue.length) return;
    const request = this.queue.shift();
    this.inFlight = true;
    this.dispatch(request);
  }

  handleWorkerMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "worker-error") {
      this.handleWorkerFailure(message.error || createError("NATIVE_DATA_WORKER_ERROR", "Native data worker failed"));
      return;
    }
    if (message.type !== "response") return;

    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    this.inFlight = false;

    if (message.ok) {
      request.resolve(message.result);
    } else {
      const err = message.error || {};
      request.reject(createError(err.code || "NATIVE_DATA_ERROR", err.message || "Native data request failed", err.details || {}));
    }
    this.drain();
  }

  handleWorkerFailure(error) {
    const nativeError = error && error.code
      ? error
      : createError("NATIVE_DATA_WORKER_ERROR", error && error.message ? error.message : "Native data worker failed");
    this.rejectAll(nativeError);
    this.destroyWorker();
    this.startPromise = null;
  }

  rejectAll(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const request of this.queue) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.queue = [];
    this.inFlight = false;
  }
}

let service = null;

function getNativeDataService(context) {
  if (!service) service = new NativeDataService(context);
  return service;
}

async function stopNativeDataService() {
  if (!service) return;
  await service.stop();
}

module.exports = {
  NativeDataService,
  getNativeDataService,
  stopNativeDataService
};
