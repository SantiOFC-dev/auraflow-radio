const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { WebSocketServer, WebSocket } = require('ws');
const { db, hashPassword, generateFrequencyForRoom, uploadsDir } = require('./db');
const { sendSecurityEmail } = require('./mailer');

const PORT = process.env.PORT || 3002;
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'auraflow_radio_ptt_secret_cr_v3_2026';
const publicDir = path.join(__dirname, 'public');

// Active SSE clients: Map<clientId, { res, userId, callsign, channel }>
const sseClients = new Map();

function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(data)
    .digest('base64url');
  return `${data}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [data, signature] = token.split('.');
  const expected = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(data)
    .digest('base64url');
  if (signature !== expected) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function getAuthUser(req, parsedUrl) {
  const authHeader = req.headers['authorization'] || '';
  let token = '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (parsedUrl && parsedUrl.searchParams.get('token')) {
    token = parsedUrl.searchParams.get('token').trim();
  }
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || !payload.userId) return null;
  const user = db
    .prepare(`
      SELECT id, callsign, name, email, role, avatar_color, current_channel,
             gps_enabled, latitude, longitude, accuracy, speed, heading,
             base_name, status, last_seen_at, created_at
      FROM users WHERE id = ?
    `)
    .get(payload.userId);
  return user || null;
}

function broadcastEvent(eventName, payload, filterFn = null) {
  const message = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const [clientId, client] of sseClients.entries()) {
    try {
      if (!filterFn || filterFn(client)) {
        client.res.write(message);
      }
    } catch {
      sseClients.delete(clientId);
    }
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Audio o payload demasiado grande (máx 25MB)'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Formato JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function transcodeToMp3(inputPath) {
  return new Promise((resolve) => {
    const mp3Path = inputPath.replace(/\.[^.]+$/, '.mp3');
    execFile(
      'ffmpeg',
      ['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '24000', '-b:a', '48k', '-f', 'mp3', mp3Path],
      { timeout: 10000 },
      (err) => {
        if (!err && fs.existsSync(mp3Path) && fs.statSync(mp3Path).size > 0) {
          fs.unlink(inputPath, () => {});
          resolve(mp3Path);
        } else {
          if (fs.existsSync(mp3Path)) fs.unlink(mp3Path, () => {});
          resolve(null);
        }
      }
    );
  });
}

async function saveAudioFromDataUrl(audioDataUrl) {
  if (!audioDataUrl || typeof audioDataUrl !== 'string') return null;
  const match = audioDataUrl.match(/^data:(audio\/[a-zA-Z0-9.+-]+)(?:;[^,]*)?;base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  let ext = 'webm';
  if (mimeType.includes('ogg')) ext = 'ogg';
  else if (mimeType.includes('mp4') || mimeType.includes('m4a') || mimeType.includes('aac')) ext = 'm4a';
  else if (mimeType.includes('wav')) ext = 'wav';
  else if (mimeType.includes('mpeg') || mimeType.includes('mp3')) ext = 'mp3';

  const buffer = Buffer.from(match[2], 'base64');
  const filename = `tx_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const fullPath = path.join(uploadsDir, filename);
  fs.writeFileSync(fullPath, buffer);

  if (ext !== 'mp3' && ext !== 'wav') {
    const mp3Path = await transcodeToMp3(fullPath);
    if (mp3Path) {
      return { url: `/uploads/${path.basename(mp3Path)}`, mimeType: 'audio/mpeg' };
    }
  }

  return { url: `/uploads/${filename}`, mimeType };
}

function getChannelsSummary() {
  const channels = db
    .prepare(`
      SELECT id, code, name, frequency_mhz, mode, is_private, description, created_by, created_at
      FROM channels
      ORDER BY is_private ASC, id ASC
    `)
    .all();

  const counts = db
    .prepare(`
      SELECT current_channel, COUNT(*) as count
      FROM users
      WHERE status != 'OFFLINE'
      GROUP BY current_channel
    `)
    .all();

  const countMap = {};
  for (const row of counts) {
    countMap[row.current_channel] = row.count;
  }

  return channels.map((ch) => ({
    ...ch,
    is_private: Boolean(ch.is_private),
    operators_count: countMap[ch.code] || 0
  }));
}

function getAllOperators() {
  return db
    .prepare(`
      SELECT id, callsign, name, email, role, avatar_color, current_channel,
             gps_enabled, latitude, longitude, accuracy, speed, heading,
             base_name, status, last_seen_at
      FROM users
      ORDER BY status = 'ONLINE' DESC, id ASC
    `)
    .all()
    .map((u) => ({
      ...u,
      gps_enabled: Boolean(u.gps_enabled)
    }));
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
};

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    if ((pathname === '/health' || pathname === '/api/health') && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        ok: true,
        status: 'ONLINE',
        service: 'auraflow-radio-ptt',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      }));
    }

    // 1. Server-Sent Events (SSE) Real-Time Stream
    if (pathname === '/api/stream' && method === 'GET') {
      const user = getAuthUser(req, parsedUrl);
      const clientId = crypto.randomUUID();

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      res.write(`event: connected\ndata: ${JSON.stringify({ clientId, timestamp: Date.now() })}\n\n`);

      sseClients.set(clientId, {
        res,
        userId: user ? user.id : null,
        callsign: user ? user.callsign : 'GUEST',
        channel: user ? user.current_channel : 'CH-01'
      });

      if (user) {
        db.prepare(`UPDATE users SET status = 'ONLINE', last_seen_at = datetime('now') WHERE id = ?`).run(user.id);
        broadcastEvent('operators_update', { operators: getAllOperators() });
      }

      const heartbeat = setInterval(() => {
        try {
          res.write(`: heartbeat ${Date.now()}\n\n`);
        } catch {
          clearInterval(heartbeat);
          sseClients.delete(clientId);
        }
      }, 20000);

      req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(clientId);
      });
      return;
    }

    if (pathname.startsWith('/api/')) {
      // Public overview endpoint (channels + operators + public transmissions)
      if (pathname === '/api/bootstrap' && method === 'GET') {
        const user = getAuthUser(req, parsedUrl);
        const activeChannel = (parsedUrl.searchParams.get('channel') || (user ? user.current_channel : 'CH-01')).toUpperCase();
        const channels = getChannelsSummary();
        const operators = getAllOperators();
        const transmissions = db
          .prepare(`
            SELECT id, channel_code, user_id, callsign, user_name, audio_url, mime_type,
                   duration_sec, note, latitude, longitude, is_sos, created_at
            FROM transmissions
            WHERE channel_code = ?
            ORDER BY id DESC
            LIMIT 40
          `)
          .all(activeChannel);

        return sendJson(res, 200, {
          user: user ? { ...user, gps_enabled: Boolean(user.gps_enabled) } : null,
          channels,
          operators,
          transmissions
        });
      }

      // Auth: Login with Email or Callsign
      if (pathname === '/api/auth/login' && method === 'POST') {
        const body = await readJsonBody(req);
        const identifier = (body.identifier || body.email || body.callsign || '').trim();
        const password = body.password || '';
        const enableGps = body.enable_gps !== undefined ? (body.enable_gps ? 1 : 0) : 1;

        if (!identifier || !password) {
          return sendJson(res, 400, {
            error: 'Ingresa tu Correo o Indicativo (Callsign) y tu contraseña.'
          });
        }

        const user = db
          .prepare(`
            SELECT * FROM users
            WHERE LOWER(email) = LOWER(?) OR LOWER(callsign) = LOWER(?)
          `)
          .get(identifier, identifier);

        if (!user || user.password_hash !== hashPassword(password)) {
          return sendJson(res, 401, {
            error: 'Credenciales inválidas. Verifica tu Correo/Indicativo (Callsign) y contraseña.'
          });
        }

        db.prepare(`
          UPDATE users
          SET status = 'ONLINE', gps_enabled = ?, last_seen_at = datetime('now')
          WHERE id = ?
        `).run(enableGps, user.id);

        const updatedUser = db
          .prepare(`
            SELECT id, callsign, name, email, role, avatar_color, current_channel,
                   gps_enabled, latitude, longitude, accuracy, speed, heading,
                   base_name, status, last_seen_at
            FROM users WHERE id = ?
          `)
          .get(user.id);

        const token = signToken({ userId: updatedUser.id, callsign: updatedUser.callsign });
        broadcastEvent('operators_update', { operators: getAllOperators() });

        return sendJson(res, 200, {
          token,
          user: { ...updatedUser, gps_enabled: Boolean(updatedUser.gps_enabled) }
        });
      }

      // Auth: Step 1 of Registration — Request 6-digit Email Verification Code
      if ((pathname === '/api/auth/register-request' || (pathname === '/api/auth/register' && !req.url.includes('direct'))) && method === 'POST') {
        const body = await readJsonBody(req);
        const rawCallsign = (body.callsign || '').trim().toUpperCase().replace(/[^A-Z0-9-_]/g, '');
        const name = (body.name || rawCallsign || 'Operador PTT').trim();
        const email = (body.email || '').trim().toLowerCase();
        const password = body.password || '';
        const enableGps = body.enable_gps !== undefined ? (body.enable_gps ? 1 : 0) : 1;

        if (!rawCallsign || rawCallsign.length < 2) {
          return sendJson(res, 400, { error: 'Ingresa un Indicativo (Callsign) válido (ej. ALFA-01, TACTICO-CR).' });
        }
        if (!email || !email.includes('@')) {
          return sendJson(res, 400, { error: 'Ingresa un correo electrónico válido.' });
        }
        if (password.length < 4) {
          return sendJson(res, 400, { error: 'La contraseña debe tener al menos 4 caracteres.' });
        }

        const existing = db
          .prepare('SELECT id, callsign, email FROM users WHERE LOWER(callsign) = LOWER(?) OR LOWER(email) = LOWER(?)')
          .get(rawCallsign, email);

        if (existing) {
          return sendJson(res, 409, {
            error: 'Ese Indicativo (Callsign) o correo electrónico ya está registrado en la red.'
          });
        }

        const code6 = String(Math.floor(100000 + Math.random() * 900000));
        const expiresAt = Date.now() + 15 * 60 * 1000;

        db.prepare(`
          INSERT INTO registration_codes (
            callsign, name, email, password_hash, enable_gps, code_6, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(rawCallsign, name, email, hashPassword(password), enableGps, code6, expiresAt);

        let emailResult = { sent: false };
        try {
          emailResult = await sendSecurityEmail({
            to: email,
            subject: `Código de Verificación ${code6} — AuraFlow Radio PTT (${rawCallsign})`,
            callsign: rawCallsign,
            code6,
            purpose: 'register'
          });
        } catch (mailErr) {
          console.error('[SMTP Register Error]:', mailErr.message);
          emailResult = { sent: false, error: mailErr.message };
        }

        return sendJson(res, 200, {
          verification_required: true,
          email_sent: Boolean(emailResult.sent),
          email,
          callsign: rawCallsign,
          code_6: emailResult.sent ? undefined : code6,
          message: emailResult.sent
            ? `📩 Te enviamos un código de verificación de 6 dígitos desde support@auraflowtech.lat a ${email}. Ingrésalo abajo para activar tu cuenta.`
            : `📩 Código de verificación de 6 dígitos generado para ${email} (desde support@auraflowtech.lat): ${code6}. Ingrésalo abajo para activar tu cuenta.`
        });
      }

      // Auth: Step 2 of Registration — Verify 6-digit Code & Activate Account
      if (pathname === '/api/auth/register-verify' && method === 'POST') {
        const body = await readJsonBody(req);
        const email = (body.email || '').trim().toLowerCase();
        const code6 = (body.code_6 || '').trim();

        if (!code6 || code6.length !== 6) {
          return sendJson(res, 400, { error: 'Ingresa el código de verificación de 6 dígitos enviado a tu correo.' });
        }

        const pending = db
          .prepare(`
            SELECT * FROM registration_codes
            WHERE code_6 = ? AND used = 0 AND (LOWER(email) = LOWER(?) OR ? = '')
            ORDER BY id DESC LIMIT 1
          `)
          .get(code6, email, email);

        if (!pending || Date.now() > pending.expires_at) {
          return sendJson(res, 400, { error: 'Código de verificación inválido o expirado. Solicita uno nuevo.' });
        }

        const existing = db
          .prepare('SELECT id FROM users WHERE LOWER(callsign) = LOWER(?) OR LOWER(email) = LOWER(?)')
          .get(pending.callsign, pending.email);

        if (existing) {
          return sendJson(res, 409, { error: 'Esta cuenta o Callsign ya fue activada.' });
        }

        db.prepare('UPDATE registration_codes SET used = 1 WHERE id = ?').run(pending.id);

        const palette = ['#06b6d4', '#10b981', '#7c3aed', '#f59e0b', '#3b82f6', '#ec4899'];
        const avatarColor = palette[Math.floor(Math.random() * palette.length)];

        const result = db
          .prepare(`
            INSERT INTO users (
              callsign, name, email, password_hash, role, avatar_color,
              current_channel, gps_enabled, latitude, longitude, status
            ) VALUES (?, ?, ?, ?, ?, ?, 'CH-01', ?, 9.3712, -83.7029, 'ONLINE')
          `)
          .run(
            pending.callsign,
            pending.name,
            pending.email,
            pending.password_hash,
            'Operador Táctico Verificado · Red AuraFlow PTT',
            avatarColor,
            pending.enable_gps
          );

        const newUser = db
          .prepare(`
            SELECT id, callsign, name, email, role, avatar_color, current_channel,
                   gps_enabled, latitude, longitude, accuracy, speed, heading,
                   base_name, status, last_seen_at
            FROM users WHERE id = ?
          `)
          .get(Number(result.lastInsertRowid));

        const token = signToken({ userId: newUser.id, callsign: newUser.callsign });
        broadcastEvent('operators_update', { operators: getAllOperators() });

        return sendJson(res, 201, {
          token,
          user: { ...newUser, gps_enabled: Boolean(newUser.gps_enabled) },
          message: `✅ Cuenta verificada y activada para ${newUser.callsign}`
        });
      }

      // Auth: Quick Founder / Command Login (AURA-01 · support@auraflowtech.lat)
      if (pathname === '/api/auth/quick' && method === 'POST') {
        const body = await readJsonBody(req);
        const targetCallsign = (body.callsign || 'AURA-01').trim().toUpperCase();
        const user =
          db.prepare('SELECT * FROM users WHERE UPPER(callsign) = ?').get(targetCallsign) ||
          db.prepare("SELECT * FROM users WHERE email = 'support@auraflowtech.lat'").get() ||
          db.prepare('SELECT * FROM users ORDER BY id ASC LIMIT 1').get();

        if (!user) {
          return sendJson(res, 404, { error: 'Operador no encontrado.' });
        }

        db.prepare(`UPDATE users SET status = 'ONLINE', last_seen_at = datetime('now') WHERE id = ?`).run(user.id);
        const token = signToken({ userId: user.id, callsign: user.callsign });
        broadcastEvent('operators_update', { operators: getAllOperators() });

        return sendJson(res, 200, {
          token,
          user: {
            id: user.id,
            callsign: user.callsign,
            name: user.name,
            email: user.email,
            role: user.role,
            avatar_color: user.avatar_color,
            current_channel: user.current_channel,
            gps_enabled: Boolean(user.gps_enabled),
            latitude: user.latitude,
            longitude: user.longitude,
            accuracy: user.accuracy,
            speed: user.speed,
            heading: user.heading,
            base_name: user.base_name,
            status: 'ONLINE'
          }
        });
      }

      // Auth: Request 6-digit Password Recovery Code (support@auraflowtech.lat)
      if (pathname === '/api/auth/recover-request' && method === 'POST') {
        const body = await readJsonBody(req);
        const identifier = (body.identifier || '').trim();
        if (!identifier) {
          return sendJson(res, 400, {
            error: 'Ingresa tu Correo Electrónico o Indicativo (Callsign) registrado.'
          });
        }

        const user = db
          .prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(callsign) = LOWER(?)')
          .get(identifier, identifier);

        if (!user) {
          return sendJson(res, 404, {
            error: 'No encontramos ningún operador con ese Correo o Indicativo (Callsign).'
          });
        }

        const code6 = String(Math.floor(100000 + Math.random() * 900000));
        const expiresAt = Date.now() + 15 * 60 * 1000;

        db.prepare(`
          INSERT INTO recovery_codes (user_id, email, callsign, code_6, expires_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(user.id, user.email, user.callsign, code6, expiresAt);

        let emailResult = { sent: false };
        try {
          emailResult = await sendSecurityEmail({
            to: user.email,
            subject: `Código de Recuperación ${code6} — AuraFlow Radio PTT (${user.callsign})`,
            callsign: user.callsign,
            code6,
            purpose: 'recover'
          });
        } catch (mailErr) {
          console.error('[SMTP Recover Error]:', mailErr.message);
          emailResult = { sent: false, error: mailErr.message };
        }

        return sendJson(res, 200, {
          ok: true,
          email_sent: Boolean(emailResult.sent),
          email: user.email,
          callsign: user.callsign,
          code_6: emailResult.sent ? undefined : code6,
          dispatcher: 'support@auraflowtech.lat',
          message: emailResult.sent
            ? `📩 Código de seguridad de 6 dígitos enviado desde support@auraflowtech.lat a ${user.email} (${user.callsign}). Ingrésalo abajo.`
            : `📩 Código de seguridad de 6 dígitos emitido por support@auraflowtech.lat para ${user.callsign} (${user.email}): ${code6}`
        });
      }

      // Auth: Verify 6-digit Code & Save New Password
      if (pathname === '/api/auth/recover-verify' && method === 'POST') {
        const body = await readJsonBody(req);
        const identifier = (body.identifier || '').trim();
        const code6 = (body.code_6 || '').trim();
        const newPassword = body.new_password || '';

        if (!code6 || code6.length !== 6) {
          return sendJson(res, 400, { error: 'Ingresa el código de seguridad de 6 dígitos.' });
        }
        if (newPassword.length < 6) {
          return sendJson(res, 400, { error: 'La nueva contraseña debe tener mínimo 6 caracteres.' });
        }

        const record = db
          .prepare(`
            SELECT * FROM recovery_codes
            WHERE code_6 = ? AND used = 0 AND (LOWER(email) = LOWER(?) OR LOWER(callsign) = LOWER(?) OR ? = '')
            ORDER BY id DESC LIMIT 1
          `)
          .get(code6, identifier, identifier, identifier);

        if (!record || Date.now() > record.expires_at) {
          return sendJson(res, 400, {
            error: 'Código de seguridad inválido o expirado. Solicita uno nuevo.'
          });
        }

        db.prepare('UPDATE recovery_codes SET used = 1 WHERE id = ?').run(record.id);
        db.prepare(`
          UPDATE users SET password_hash = ?, status = 'ONLINE', last_seen_at = datetime('now')
          WHERE id = ?
        `).run(hashPassword(newPassword), record.user_id);

        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(record.user_id);
        const token = signToken({ userId: user.id, callsign: user.callsign });

        broadcastEvent('operators_update', { operators: getAllOperators() });

        return sendJson(res, 200, {
          token,
          user: { ...user, gps_enabled: Boolean(user.gps_enabled) },
          message: 'Contraseña actualizada correctamente. Entrando al radio...'
        });
      }

      // Protected Routes require user token
      const user = getAuthUser(req, parsedUrl);
      if (!user) {
        return sendJson(res, 401, { error: 'Inicia sesión con tu Indicativo (Callsign) o Correo para operar el radio.' });
      }

      // Logout
      if (pathname === '/api/auth/logout' && method === 'POST') {
        db.prepare(`UPDATE users SET status = 'STANDBY', last_seen_at = datetime('now') WHERE id = ?`).run(user.id);
        broadcastEvent('operators_update', { operators: getAllOperators() });
        return sendJson(res, 200, { ok: true });
      }

      // Tune Public Channel or Create/Validate Private PIN Frequency (e.g. ALFA-1)
      if (pathname === '/api/channels/tune' && method === 'POST') {
        const body = await readJsonBody(req);
        const rawCode = (body.code || '').trim().toUpperCase().replace(/[^A-Z0-9-_]/g, '');
        const pin = body.pin ? String(body.pin).trim() : null;

        if (!rawCode) {
          return sendJson(res, 400, { error: 'Ingresa un código de canal o sala válido (ej. CH-01 o ALFA-1).' });
        }

        let channel = db.prepare('SELECT * FROM channels WHERE UPPER(code) = ?').get(rawCode);

        if (!channel) {
          // Create private room with PIN on the fly!
          if (!pin || pin.length < 2) {
            return sendJson(res, 400, {
              error: 'Para crear una nueva frecuencia privada debes definir un PIN secreto.'
            });
          }
          const freq = generateFrequencyForRoom(rawCode);
          db.prepare(`
            INSERT INTO channels (code, name, frequency_mhz, mode, is_private, pin_code, description, created_by)
            VALUES (?, ?, ?, 'MODO: CIFRADO PIN', 1, ?, ?, ?)
          `).run(
            rawCode,
            `Sala Táctica ${rawCode}`,
            freq,
            pin,
            `Frecuencia privada creada por ${user.callsign}`,
            user.callsign
          );
          channel = db.prepare('SELECT * FROM channels WHERE UPPER(code) = ?').get(rawCode);
        } else if (channel.is_private) {
          if (!pin || pin !== channel.pin_code) {
            return sendJson(res, 403, {
              error: `PIN incorrecto para la frecuencia privada ${channel.code}. Verifica el PIN de acceso.`
            });
          }
        }

        db.prepare(`
          UPDATE users SET current_channel = ?, status = 'ONLINE', last_seen_at = datetime('now')
          WHERE id = ?
        `).run(channel.code, user.id);

        // Update SSE client channel
        for (const client of sseClients.values()) {
          if (client.userId === user.id) {
            client.channel = channel.code;
          }
        }

        const transmissions = db
          .prepare(`
            SELECT id, channel_code, user_id, callsign, user_name, audio_url, mime_type,
                   duration_sec, note, latitude, longitude, is_sos, created_at
            FROM transmissions
            WHERE channel_code = ?
            ORDER BY id DESC
            LIMIT 40
          `)
          .all(channel.code);

        broadcastEvent('operators_update', {
          operators: getAllOperators(),
          channels: getChannelsSummary()
        });

        return sendJson(res, 200, {
          channel: {
            ...channel,
            is_private: Boolean(channel.is_private)
          },
          transmissions,
          channels: getChannelsSummary(),
          operators: getAllOperators()
        });
      }

      // Live PTT Carrier TX State (start / stop)
      if (pathname === '/api/ptt/state' && method === 'POST') {
        const body = await readJsonBody(req);
        const state = body.state === 'TX' ? 'TX' : 'ONLINE';
        const channelCode = (body.channel || user.current_channel || 'CH-01').toUpperCase();

        db.prepare(`UPDATE users SET status = ?, last_seen_at = datetime('now') WHERE id = ?`).run(state, user.id);

        broadcastEvent(
          state === 'TX' ? 'ptt_start' : 'ptt_stop',
          {
            userId: user.id,
            callsign: user.callsign,
            name: user.name,
            channel: channelCode,
            timestamp: Date.now()
          }
        );

        return sendJson(res, 200, { ok: true, state });
      }

      // Live Call Tone Alert on Active Channel
      if (pathname === '/api/ptt/call-tone' && method === 'POST') {
        const body = await readJsonBody(req);
        const channelCode = (body.channel || user.current_channel || 'CH-01').toUpperCase();

        broadcastEvent('call_tone', {
          userId: user.id,
          callsign: user.callsign,
          name: user.name,
          channel: channelCode,
          timestamp: Date.now()
        });

        return sendJson(res, 200, { ok: true });
      }

      // Save & Broadcast Voice Transmission
      if (pathname === '/api/transmissions' && method === 'POST') {
        const body = await readJsonBody(req);
        const channelCode = (body.channel || user.current_channel || 'CH-01').toUpperCase();
        const durationSec = Number(body.duration_sec) || 1.8;
        const note = (body.note || '').trim();
        const isSos = body.is_sos ? 1 : 0;
        const savedAudio = await saveAudioFromDataUrl(body.audio_data);

        if (!savedAudio) {
          return sendJson(res, 400, { error: 'No se recibió audio válido para transmitir.' });
        }

        const result = db
          .prepare(`
            INSERT INTO transmissions (
              channel_code, user_id, callsign, user_name, audio_url, mime_type,
              duration_sec, note, latitude, longitude, is_sos
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            channelCode,
            user.id,
            user.callsign,
            user.name,
            savedAudio.url,
            savedAudio.mimeType,
            durationSec,
            note,
            user.latitude,
            user.longitude,
            isSos
          );

        db.prepare(`UPDATE users SET status = 'ONLINE', last_seen_at = datetime('now') WHERE id = ?`).run(user.id);

        const transmission = db
          .prepare('SELECT * FROM transmissions WHERE id = ?')
          .get(Number(result.lastInsertRowid));

        broadcastEvent('transmission', {
          transmission,
          live_streamed: Boolean(body.live_streamed)
        });

        return sendJson(res, 201, { transmission });
      }

      // Update GPS Telemetry / Set Base CR
      if (pathname === '/api/gps/update' && method === 'POST') {
        const body = await readJsonBody(req);
        const gpsEnabled = body.gps_enabled !== undefined ? (body.gps_enabled ? 1 : 0) : 1;
        const lat = body.latitude !== undefined ? Number(body.latitude) : user.latitude;
        const lng = body.longitude !== undefined ? Number(body.longitude) : user.longitude;
        const accuracy = body.accuracy !== undefined ? Number(body.accuracy) : user.accuracy;
        const speed = body.speed !== undefined ? Number(body.speed) : user.speed;
        const heading = body.heading !== undefined ? Number(body.heading) : user.heading;
        const baseName = body.base_name !== undefined ? String(body.base_name).trim() : user.base_name;

        db.prepare(`
          UPDATE users
          SET gps_enabled = ?, latitude = ?, longitude = ?, accuracy = ?,
              speed = ?, heading = ?, base_name = ?, last_seen_at = datetime('now')
          WHERE id = ?
        `).run(gpsEnabled, lat, lng, accuracy, speed, heading, baseName, user.id);

        const operators = getAllOperators();
        broadcastEvent('gps_update', {
          userId: user.id,
          callsign: user.callsign,
          gps_enabled: Boolean(gpsEnabled),
          latitude: lat,
          longitude: lng,
          accuracy,
          speed,
          base_name: baseName,
          operators
        });

        return sendJson(res, 200, {
          ok: true,
          operators
        });
      }

      // Direct 1:1 Call or SOS Alert
      if (pathname === '/api/calls/direct' && method === 'POST') {
        const body = await readJsonBody(req);
        const targetUserId = body.to_user_id ? Number(body.to_user_id) : null;
        const callType = body.call_type === 'SOS' ? 'SOS' : '1:1';
        const customMessage = (body.message || '').trim();
        const lat = body.latitude !== undefined ? Number(body.latitude) : user.latitude;
        const lng = body.longitude !== undefined ? Number(body.longitude) : user.longitude;

        let targetUser = null;
        if (targetUserId) {
          targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId);
        }

        const roomCode =
          callType === 'SOS'
            ? 'CH-04'
            : `1A1-${user.callsign}-${targetUser ? targetUser.callsign : 'DIR'}`.slice(0, 18);

        if (callType === '1:1') {
          const existingRoom = db.prepare('SELECT id FROM channels WHERE code = ?').get(roomCode);
          if (!existingRoom) {
            db.prepare(`
              INSERT INTO channels (code, name, frequency_mhz, mode, is_private, pin_code, description, created_by)
              VALUES (?, ?, ?, 'MODO: ENLACE DIRECTO 1:1', 0, NULL, ?, ?)
            `).run(
              roomCode,
              `Enlace 1:1 (${user.callsign} ⇄ ${targetUser ? targetUser.callsign : 'Operador'})`,
              generateFrequencyForRoom(roomCode),
              `Canal directo 1 a 1 iniciado por ${user.callsign}`,
              user.callsign
            );
          }
        }

        const result = db
          .prepare(`
            INSERT INTO direct_calls (
              from_user_id, from_callsign, from_name, to_user_id, to_callsign,
              call_type, room_code, latitude, longitude, message, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
          `)
          .run(
            user.id,
            user.callsign,
            user.name,
            targetUser ? targetUser.id : null,
            targetUser ? targetUser.callsign : 'TODOS',
            callType,
            roomCode,
            lat,
            lng,
            customMessage || (callType === 'SOS' ? '¡ALERTA SOS TÁCTICA! Solicito asistencia inmediata en coordenadas GPS.' : `Solicitud de enlace directo 1:1 de ${user.callsign}`)
          );

        const callRecord = db.prepare('SELECT * FROM direct_calls WHERE id = ?').get(Number(result.lastInsertRowid));

        broadcastEvent('direct_call', {
          call: callRecord,
          channels: getChannelsSummary()
        });

        return sendJson(res, 201, {
          call: callRecord,
          room_code: roomCode
        });
      }

      return sendJson(res, 404, { error: 'Endpoint no encontrado' });
    }

    // Serve uploaded audio recordings with Range support (required by iOS Safari)
    if (pathname.startsWith('/uploads/')) {
      const safeName = path.basename(pathname);
      const filePath = path.join(uploadsDir, safeName);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'audio/webm';
        const stat = fs.statSync(filePath);
        const total = stat.size;
        const range = req.headers.range;

        if (range) {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
          if (Number.isNaN(start) || start >= total || end >= total || start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` });
            res.end();
            return;
          }
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400'
          });
          fs.createReadStream(filePath, { start, end }).pipe(res);
          return;
        }

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': total,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=86400'
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      res.writeHead(404);
      res.end('Audio not found');
      return;
    }

    // Serve static frontend files
    let filePath = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(publicDir, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('[AuraFlow Radio Error]:', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: err.message || 'Error interno del servidor de radio' });
    }
  }
});

// Real-Time Live Audio WebSocket Relay (/ws)
const wsClients = new Set();
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const user = getAuthUser(req, parsedUrl);
  if (!user) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  const client = {
    ws,
    userId: user.id,
    callsign: user.callsign,
    channel: (parsedUrl.searchParams.get('channel') || user.current_channel || 'CH-01').toUpperCase(),
    sampleRate: 16000,
    echo: false
  };
  wsClients.add(client);

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.type === 'channel' && msg.channel) {
          client.channel = String(msg.channel).toUpperCase();
        } else if (msg.type === 'live_start') {
          if (msg.channel) client.channel = String(msg.channel).toUpperCase();
          if (msg.sampleRate) client.sampleRate = Number(msg.sampleRate) || 16000;
          client.echo = Boolean(msg.echo);
          const payload = JSON.stringify({
            type: 'live_start',
            userId: client.userId,
            callsign: client.callsign,
            channel: client.channel,
            sampleRate: client.sampleRate
          });
          for (const other of wsClients) {
            if (other.ws.readyState !== WebSocket.OPEN) continue;
            if (other.channel !== client.channel) continue;
            if (other === client && !client.echo) continue;
            other.ws.send(payload);
          }
        } else if (msg.type === 'live_stop') {
          const payload = JSON.stringify({
            type: 'live_stop',
            userId: client.userId,
            callsign: client.callsign,
            channel: client.channel
          });
          for (const other of wsClients) {
            if (other.ws.readyState !== WebSocket.OPEN) continue;
            if (other.channel !== client.channel) continue;
            if (other === client && !client.echo) continue;
            other.ws.send(payload);
          }
        }
      } catch {}
      return;
    }

    // Binary PCM Int16 frame: prefix 8-byte header [userId (uint32LE), sampleRate (uint32LE)]
    const pcmBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (pcmBuf.length < 2) return;
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32LE(client.userId >>> 0, 0);
    header.writeUInt32LE(client.sampleRate >>> 0, 4);
    const frame = Buffer.concat([header, pcmBuf]);

    for (const other of wsClients) {
      if (other.ws.readyState !== WebSocket.OPEN) continue;
      if (other.channel !== client.channel) continue;
      if (other === client && !client.echo) continue;
      other.ws.send(frame, { binary: true });
    }
  });

  ws.on('close', () => {
    wsClients.delete(client);
  });

  ws.on('error', () => {
    wsClients.delete(client);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[PTT + GPS v3.0 AuraFlow Radio] Servidor táctico activo en http://0.0.0.0:${PORT}`);
});
