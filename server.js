const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const LOCAL_STATE_FILE = process.env.LOCAL_STATE_FILE || path.join(__dirname, "state.json");
const DEFAULT_STATE = {
  tasks: [],
  checks: {},
  people: []
};

const app = express();
app.use(express.json({ limit: "1mb" }));

let pool = null;

function parseIsoDate(value) {
  if (!value) {
    return new Date().toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function normalizeStatePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return DEFAULT_STATE;
  }

  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  const checks = payload.checks && typeof payload.checks === "object" ? payload.checks : {};
  const people = Array.isArray(payload.people) ? payload.people : [];
  return { tasks, checks, people };
}

async function setupDatabase() {
  if (!DATABASE_URL) {
    return;
  }

  const useSsl = !/localhost|127\.0\.0\.1/.test(DATABASE_URL);
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : false
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(
    `
    INSERT INTO app_state (id, data)
    VALUES (1, $1::jsonb)
    ON CONFLICT (id) DO NOTHING;
    `,
    [JSON.stringify(DEFAULT_STATE)]
  );
}

async function readLocalState() {
  try {
    const raw = await fs.readFile(LOCAL_STATE_FILE, "utf8");
    return normalizeStatePayload(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    await fs.writeFile(LOCAL_STATE_FILE, JSON.stringify(DEFAULT_STATE, null, 2), "utf8");
    return { ...DEFAULT_STATE };
  }
}

async function writeLocalState(data) {
  const normalized = normalizeStatePayload(data);
  await fs.writeFile(LOCAL_STATE_FILE, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

async function readState() {
  if (pool) {
    const result = await pool.query("SELECT data, updated_at FROM app_state WHERE id = 1");
    const row = result.rows[0];
    return {
      data: normalizeStatePayload(row ? row.data : DEFAULT_STATE),
      revision: parseIsoDate(row ? row.updated_at : null)
    };
  }

  const data = await readLocalState();
  const stats = await fs.stat(LOCAL_STATE_FILE);
  return {
    data,
    revision: parseIsoDate(stats.mtime)
  };
}

async function writeState(data) {
  const normalized = normalizeStatePayload(data);

  if (pool) {
    const result = await pool.query(
      `
      INSERT INTO app_state (id, data, updated_at)
      VALUES (1, $1::jsonb, NOW())
      ON CONFLICT (id)
      DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
      RETURNING updated_at;
      `,
      [JSON.stringify(normalized)]
    );

    return {
      data: normalized,
      revision: parseIsoDate(result.rows[0].updated_at)
    };
  }

  await writeLocalState(normalized);
  const stats = await fs.stat(LOCAL_STATE_FILE);
  return {
    data: normalized,
    revision: parseIsoDate(stats.mtime)
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, storage: pool ? "postgres" : "json-file" });
});

app.get("/api/state", async (_req, res, next) => {
  try {
    const state = await readState();
    res.json(state);
  } catch (error) {
    next(error);
  }
});

app.put("/api/state", async (req, res, next) => {
  try {
    const incoming = req.body && req.body.data;
    if (!incoming || typeof incoming !== "object") {
      res.status(400).json({ error: "Payload invalido. Se esperaba { data: {...} }" });
      return;
    }

    const saved = await writeState(incoming);
    res.json(saved);
  } catch (error) {
    next(error);
  }
});

app.use(express.static(__dirname));

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Error interno del servidor" });
});

setupDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("No se pudo iniciar el servidor", error);
    process.exit(1);
  });
