const JSONbig = require("json-bigint")({ storeAsString: true });

function parseLosslessJson(value) {
  return JSONbig.parse(typeof value === "string" ? value : String(value ?? ""));
}

module.exports = { parseLosslessJson };
