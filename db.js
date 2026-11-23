const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'auraflow_radio.db');
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    callsign TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'Operador Táctico PTT',
    avatar_color TEXT DEFAULT '#06b6d4',
    current_channel TEXT DEFAULT 'CH-01',
    gps_enabled INTEGER DEFAULT 1,
    latitude REAL DEFAULT 9.3712,
    longitude REAL DEFAULT -83.7029,
    accuracy REAL DEFAULT 8.5,
    speed REAL DEFAULT 0.0,
    heading REAL DEFAULT 0.0,
    base_name TEXT DEFAULT 'Base Operaciones CR · Zona Sur',
    status TEXT DEFAULT 'ONLINE',
    last_seen_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    frequency_mhz TEXT NOT NULL,
    mode TEXT DEFAULT 'MODO: VHF FILTRADO',
    is_private INTEGER DEFAULT 0,
    pin_code TEXT DEFAULT NULL,
    description TEXT DEFAULT '',
    created_by TEXT DEFAULT 'SYSTEM',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transmissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_code TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    callsign TEXT NOT NULL,
    user_name TEXT NOT NULL,
    audio_url TEXT NOT NULL,
    mime_type TEXT DEFAULT 'audio/webm',
    duration_sec REAL DEFAULT 1.5,
    note TEXT DEFAULT '',
    latitude REAL,
    longitude REAL,
    is_sos INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS direct_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER NOT NULL,
    from_callsign TEXT NOT NULL,
    from_name TEXT NOT NULL,
    to_user_id INTEGER,
    to_callsign TEXT,
    call_type TEXT DEFAULT '1:1',
    room_code TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    message TEXT DEFAULT '',
    status TEXT DEFAULT 'PENDING',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS recovery_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    callsign TEXT NOT NULL,
    code_6 TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS registration_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    callsign TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    enable_gps INTEGER DEFAULT 1,
    code_6 TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

function hashPassword(password) {
  const salt = 'auraflow_radio_ptt_salt_cr_v3';
  return crypto.pbkdf2Sync(String(password), salt, 10000, 64, 'sha512').toString('hex');
}

function generateFrequencyForRoom(code) {
  let hash = 0;
  for (let i = 0; i < code.length; i++) {
    hash = (hash * 31 + code.charCodeAt(i)) % 800;
  }
  const freq = 467.0 + (hash * 0.0125);
  return `${freq.toFixed(4)} MHz`;
}

function seedInitialData() {
  const defaultChannels = [
    {
      code: 'CH-01',
      name: 'General / Lobby',
      frequency_mhz: '462.5625 MHz',
      mode: 'MODO: VHF FILTRADO',
      is_private: 0,
      pin_code: null,
      description: 'Canal público abierto principal · Lobby General CR'
    },
    {
      code: 'CH-02',
      name: 'Táctico / Operativo 1',
      frequency_mhz: '462.5875 MHz',
      mode: 'MODO: VHF FILTRADO',
      is_private: 0,
      pin_code: null,
      description: 'Canal de operaciones de campo y coordinación rápida'
    },
    {
      code: 'CH-03',
      name: 'Logística / Soporte',
      frequency_mhz: '462.6125 MHz',
      mode: 'MODO: VHF FILTRADO',
      is_private: 0,
      pin_code: null,
      description: 'Despacho de unidades, rutas y soporte técnico'
    },
    {
      code: 'CH-04',
      name: 'Emergencias / Monitoreo',
      frequency_mhz: '462.6375 MHz',
      mode: 'MODO: VHF PRIORITARIO',
      is_private: 0,
      pin_code: null,
      description: 'Canal de alerta SOS y supervisión de telemetría GPS'
    },
    {
      code: 'CH-05',
      name: 'Flota / Tránsito',
      frequency_mhz: '462.6625 MHz',
      mode: 'MODO: VHF FILTRADO',
      is_private: 0,
      pin_code: null,
      description: 'Seguimiento satelital de unidades móviles en ruta'
    },
    {
      code: 'CH-06',
      name: 'Comando / Privado',
      frequency_mhz: '462.6875 MHz',
      mode: 'MODO: CIFRADO PIN',
      is_private: 1,
      pin_code: '1234',
      description: 'Sala privada protegida por PIN (PIN por defecto: 1234)'
    }
  ];

  const insertChannel = db.prepare(`
    INSERT OR IGNORE INTO channels (code, name, frequency_mhz, mode, is_private, pin_code, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const ch of defaultChannels) {
    insertChannel.run(
      ch.code,
      ch.name,
      ch.frequency_mhz,
      ch.mode,
      ch.is_private,
      ch.pin_code,
      ch.description
    );
  }

  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount === 0) {
    const insertUser = db.prepare(`
      INSERT INTO users (
        callsign, name, email, password_hash, role, avatar_color,
        current_channel, gps_enabled, latitude, longitude, accuracy, speed, base_name, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // 1. Founder / Central Command
    insertUser.run(
      'AURA-01',
      'Ing. Santiago Delgado Leiva',
      'support@auraflowtech.lat',
      hashPassword('auraflow2026'),
      'Comandante Red · AuraFlow Tech CR',
      '#06b6d4',
      'CH-01',
      1,
      9.3712,
      -83.7029,
      6.0,
      0.0,
      'Base Central · San Isidro de El General, PZ',
      'ONLINE'
    );

    // 2. Tactical Field Unit 2 (Dominical / Uvita)
    insertUser.run(
      'DELTA-SUR',
      'Unidad Móvil Costa Ballena',
      'delta@auraflowtech.lat',
      hashPassword('auraflow2026'),
      'Patrulla Logística · Ruta 34 Costanera',
      '#10b981',
      'CH-01',
      1,
      9.1628,
      -83.7389,
      10.2,
      45.0,
      'Sector Uvita / Marino Ballena, Osa',
      'ONLINE'
    );

    // 3. Tactical Field Unit 3 (San José / GAM)
    insertUser.run(
      'ALFA-GAM',
      'Nodo Enlace San José',
      'alfa@auraflowtech.lat',
      hashPassword('auraflow2026'),
      'Operador Enlace · Central GAM',
      '#7c3aed',
      'CH-01',
      1,
      9.9333,
      -84.0833,
      12.0,
      0.0,
      'Enlace Repetidora · San José, CR',
      'ONLINE'
    );
  }
}

seedInitialData();

module.exports = {
  db,
  hashPassword,
  generateFrequencyForRoom,
  uploadsDir
};
