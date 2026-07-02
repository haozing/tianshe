const { app, ipcMain } = require("electron");
const path = require("node:path");

const nedbMap = new Map();
const sqliteMap = new Map();

function getNedb(dbName) {
  if (!nedbMap.has(dbName)) {
    const Datastore = require("nedb");
    const filename = path.join(app.getPath("userData"), `${dbName}.nedb`);
    nedbMap.set(dbName, new Datastore({ filename, autoload: true }));
  }
  return nedbMap.get(dbName);
}

function getSqlite(dbName) {
  if (!sqliteMap.has(dbName)) {
    const Database = require("better-sqlite3");
    const filename = path.join(app.getPath("userData"), `${dbName}.db`);
    const db = new Database(filename);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${dbName} (
        id TEXT PRIMARY KEY,
        data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${dbName}_updatedAt ON ${dbName}(updated_at)`);
    sqliteMap.set(dbName, db);
  }
  return sqliteMap.get(dbName);
}

function registerNedbHandlers() {
  ipcMain.handle("db", async (_event, args = {}) => {
    const { dbName, cmd } = args;
    if (!dbName) throw new Error("Missing dbName in args");
    const db = getNedb(dbName);

    return new Promise((resolve, reject) => {
      if (cmd === "search") {
        db.find({}, (err, docs) => {
          if (err) return reject(err);
          docs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
          resolve(docs);
        });
        return;
      }

      if (cmd === "insert") {
        db.insert(args.row, (err, doc) => err ? reject(err) : resolve(doc));
        return;
      }

      if (cmd === "update") {
        db.update({ _id: args.row._id }, args.row, {}, (err, num) => err ? reject(err) : resolve(num));
        return;
      }

      if (cmd === "findById") {
        db.findOne({ id: args.id }, (err, doc) => err ? reject(err) : resolve(doc));
        return;
      }

      if (cmd === "delete") {
        db.remove({ id: args.id }, {}, (err, num) => {
          if (err) return reject(err);
          if (!args.isNotClearLogs) db.persistence.compactDatafile();
          resolve(num);
        });
        return;
      }

      if (cmd === "count") {
        db.count(args.query || {}).skip(args.skip || 0).limit(args.limit || 0).exec((err, count) => err ? reject(err) : resolve(count));
        return;
      }

      if (cmd === "findLimit") {
        let query = db.find(args.query || {});
        if (args.sort && Object.keys(args.sort).length) query = query.sort(args.sort);
        query.skip(args.skip || 0).limit(args.limit || 0).exec((err, docs) => err ? reject(err) : resolve(docs));
        return;
      }

      if (cmd === "insertMany") {
        if (!Array.isArray(args.rows)) return reject(new Error('Expected an array for "rows"'));
        db.insert(args.rows, (err, docs) => err ? reject(err) : resolve(docs));
        return;
      }

      if (cmd === "batchDelete" || cmd === "resetDatabase") {
        db.remove(args.query || {}, { multi: true }, (err, num) => {
          if (err) return reject(err);
          if (!args.isNotClearLogs) db.persistence.compactDatafile();
          resolve(num);
        });
        return;
      }

      reject(new Error(`Unknown command: ${cmd}`));
    });
  });
}

function registerSqliteHandlers() {
  ipcMain.handle("_db", async (_event, args = {}) => {
    const { dbName, cmd } = args;
    if (!dbName) throw new Error("Missing dbName in args");
    const db = getSqlite(dbName);

    switch (cmd) {
      case "insert":
        return insertMany(db, dbName, [args.row]);
      case "insertMany":
        return insertMany(db, dbName, args.rows);
      case "delete":
        return deleteRows(db, dbName, { id: { $in: [args.id] } });
      case "batchDelete":
      case "resetDatabase":
        return deleteRows(db, dbName, args.query || {});
      case "update":
        return updateRow(db, dbName, args.row);
      case "batchUpdate":
        return batchUpdateRows(db, dbName, args.rows);
      case "findById": {
        const rows = findRows(db, dbName, { id: { $in: [args.id] } }, args.sort, args.skip, args.limit);
        return rows[0];
      }
      case "search":
      case "findLimit":
        return findRows(db, dbName, args.query || {}, args.sort || {}, args.skip, args.limit);
      case "count":
        return countRows(db, dbName, args.query || {});
      case "selfSql":
        return selfSql(db, args.sql, args.sqlParams, dbName);
      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  });
}

function insertMany(db, dbName, rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Expected an array for "rows"');
  const now = new Date().toISOString();
  const check = db.prepare(`SELECT id FROM ${dbName} WHERE id = ?`);
  const insert = db.prepare(`INSERT INTO ${dbName} (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)`);
  const inserted = [];

  db.transaction((list) => {
    for (const row of list) {
      const id = row.id || generateId();
      if (check.get(id)) continue;
      const next = { ...row, id, created_at: row.created_at || now, updated_at: now };
      const result = insert.run(next.id, JSON.stringify(next), next.created_at, next.updated_at);
      inserted.push({ ...next, _id: result.lastInsertRowid });
    }
  })(rows);

  return inserted;
}

function updateRow(db, dbName, row) {
  const updated = { ...row, updated_at: new Date().toISOString() };
  const stmt = db.prepare(`UPDATE ${dbName} SET data = ?, updated_at = ? WHERE id = ?`);
  return stmt.run(JSON.stringify(updated), updated.updated_at, row.id).changes;
}

function batchUpdateRows(db, dbName, rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Expected an array for "rows"');
  db.transaction((list) => {
    for (const row of list) updateRow(db, dbName, row);
  })(rows);
  return rows.length;
}

function deleteRows(db, dbName, query) {
  const { whereClause, params } = buildWhere(query);
  const result = db.prepare(`DELETE FROM ${dbName} ${whereClause}`).run(...params);
  setImmediate(() => db.exec("VACUUM"));
  return result.changes;
}

function findRows(db, dbName, query, sort, skip, limit) {
  const { whereClause, params } = buildWhere(query);
  const orderBy = sort && Object.keys(sort).length
    ? `ORDER BY ${Object.keys(sort).map((key) => `${jsonKey(key)} ${sort[key] === 1 ? "ASC" : "DESC"}`).join(", ")}`
    : "";
  const page = limit ? "LIMIT ? OFFSET ?" : "";
  const pageParams = limit ? [limit, skip || 0] : [];
  return db.prepare(`SELECT * FROM ${dbName} ${whereClause} ${orderBy} ${page}`)
    .all(...params, ...pageParams)
    .map((row) => JSON.parse(row.data));
}

function countRows(db, dbName, query) {
  const { whereClause, params } = buildWhere(query);
  const result = db.prepare(`SELECT COUNT(*) as count FROM ${dbName} ${whereClause}`).get(...params);
  return result ? result.count : 0;
}

function selfSql(db, sql, sqlParams = []) {
  if (!sql || typeof sql !== "string") throw new Error("Invalid SQL statement");
  const stmt = db.prepare(sql);
  const upper = sql.trim().toUpperCase();
  if (stmt.reader || /^(SELECT|WITH|VALUES|EXPLAIN|PRAGMA)\b/.test(upper)) {
    return upper.includes("COUNT(") ? stmt.get(...sqlParams) : stmt.all(...sqlParams);
  }
  const result = stmt.run(...sqlParams);
  return {
    lastInsertRowid: result.lastInsertRowid,
    changes: result.changes
  };
}

function buildWhere(query = {}) {
  const entries = Object.entries(query || {});
  if (!entries.length) return { whereClause: "", params: [] };

  const conditions = [];
  const params = [];
  for (const [key, value] of entries) {
    if (key === "$and" && Array.isArray(value)) {
      const parts = value.map(buildWhere).filter((item) => item.whereClause);
      conditions.push(parts.map((item) => `(${item.whereClause.replace(/^WHERE\s+/, "")})`).join(" AND "));
      parts.forEach((item) => params.push(...item.params));
      continue;
    }
    if (key === "$or" && Array.isArray(value)) {
      const parts = value.map(buildWhere).filter((item) => item.whereClause);
      conditions.push(parts.map((item) => `(${item.whereClause.replace(/^WHERE\s+/, "")})`).join(" OR "));
      parts.forEach((item) => params.push(...item.params));
      continue;
    }

    const field = jsonKey(key);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const built = buildOperatorConditions(field, value);
      conditions.push(built.condition);
      params.push(...built.params);
    } else {
      conditions.push(`${field} = ?`);
      params.push(value);
    }
  }

  return {
    whereClause: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params
  };
}

function buildOperatorConditions(field, operators) {
  const parts = [];
  const params = [];
  for (const [operator, value] of Object.entries(operators)) {
    if (operator === "$gt") parts.push(`${field} > ?`);
    else if (operator === "$lt") parts.push(`${field} < ?`);
    else if (operator === "$gte") parts.push(`${field} >= ?`);
    else if (operator === "$lte") parts.push(`${field} <= ?`);
    else if (operator === "$ne") parts.push(`${field} != ?`);
    else if (operator === "$in" || operator === "$nin") {
      const values = Array.isArray(value) ? value : [value];
      const placeholders = values.map(() => "?").join(",");
      parts.push(`${field} ${operator === "$in" ? "IN" : "NOT IN"} (${placeholders})`);
      params.push(...values);
      continue;
    } else if (operator === "$regex") {
      parts.push(`${field} LIKE ?`);
      params.push(`%${String(value).replace(/^\/|\/[gimsuy]*$/g, "").replace(/\.\*/g, "%")}%`);
      continue;
    } else {
      parts.push("1=1");
      continue;
    }
    params.push(value);
  }
  return { condition: parts.join(" AND "), params };
}

function jsonKey(key) {
  return `json_extract(data, '$.${key}')`;
}

function generateId() {
  return Math.random().toString(36).slice(2, 11);
}

function registerDbHandlers() {
  registerNedbHandlers();
  registerSqliteHandlers();
}

module.exports = { registerDbHandlers };

