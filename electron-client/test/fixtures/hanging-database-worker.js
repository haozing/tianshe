const { parentPort } = require("node:worker_threads");

parentPort.on("message", (message) => {
  if (!message || message.type !== "request") return;
  if (message.method === "hang") return;
  parentPort.postMessage({
    type: "response",
    id: message.id,
    ok: true,
    result: message.method === "echo" ? message.args?.value : { ok: true }
  });
});
