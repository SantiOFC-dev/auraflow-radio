const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');

const envPath = path.join(__dirname, '.env');

function getSmtpConfig() {
  const config = {
    host: process.env.SMTP_HOST || 'mail.spacemail.com',
    port: Number(process.env.SMTP_PORT || 465),
    user: process.env.SMTP_USER || 'support@auraflowtech.lat',
    pass: process.env.SMTP_PASS || ''
  };

  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key === 'SMTP_HOST' && val) config.host = val;
      if (key === 'SMTP_PORT' && val) config.port = Number(val);
      if (key === 'SMTP_USER' && val) config.user = val;
      if (key === 'SMTP_PASS' && val) config.pass = val;
    }
  }
  return config;
}

async function sendSecurityEmail({ to, subject, callsign, code6, purpose }) {
  const cfg = getSmtpConfig();
  if (!cfg.pass) {
    return {
      sent: false,
      reason: 'SMTP_PASS_NOT_SET'
    };
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: {
      user: cfg.user,
      pass: cfg.pass
    },
    tls: {
      rejectUnauthorized: false
    }
  });

  const html = `
    <div style="font-family: 'Inter', Arial, sans-serif; max-width: 540px; margin: 0 auto; background: #0b1120; color: #f8fafc; border: 1px solid #06b6d4; border-radius: 16px; padding: 28px;">
      <div style="font-family: monospace; color: #22d3ee; font-size: 13px; font-weight: bold; letter-spacing: 1px;">
        PTT + GPS v3.0 · AURAFLOW RADIO CR
      </div>
      <h2 style="margin: 10px 0 14px; color: #ffffff; font-size: 22px;">
        ${purpose === 'register' ? 'Activación de Cuenta e Indicativo (Callsign)' : 'Código de Recuperación de Acceso'}
      </h2>
      <p style="color: #cbd5e1; font-size: 15px; line-height: 1.6;">
        Hola <strong>${callsign}</strong>, aquí tienes tu código de seguridad de 6 dígitos emitido por <strong>AuraFlow Tech</strong> para ${purpose === 'register' ? 'confirmar tu correo y activar tu Indicativo en el Radio PTT' : 'restablecer tu contraseña'}:
      </p>
      <div style="margin: 22px 0; text-align: center; background: #07191e; border: 2px dashed #22d3ee; border-radius: 12px; padding: 18px;">
        <span style="font-family: monospace; font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #34d399;">
          ${code6}
        </span>
      </div>
      <p style="color: #94a3b8; font-size: 13px;">
        Este código es válido por 15 minutos. Ingresa estos 6 dígitos en <a href="https://radio.auraflowtech.lat" style="color: #22d3ee;">radio.auraflowtech.lat</a> para continuar.
      </p>
      <hr style="border: none; border-top: 1px solid rgba(148,163,184,0.2); margin: 20px 0;" />
      <div style="color: #64748b; font-size: 12px;">
        AuraFlow Tech Costa Rica · Ing. Santiago Delgado Leiva · <a href="mailto:support@auraflowtech.lat" style="color: #22d3ee;">support@auraflowtech.lat</a>
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: `"AuraFlow Radio PTT" <${cfg.user}>`,
    to,
    subject,
    text: `AuraFlow Radio PTT — Código de seguridad para ${callsign}: ${code6}`,
    html
  });

  return { sent: true };
}

module.exports = {
  sendSecurityEmail,
  getSmtpConfig
};
