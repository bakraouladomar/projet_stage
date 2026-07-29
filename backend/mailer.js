'use strict';
/**
 * mailer.js — Envoi du rapport par email via SMTP (Gmail / Outlook d'entreprise).
 * La configuration vient des variables d'environnement (.env).
 */
const nodemailer = require('nodemailer');

function buildTransport() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    throw new Error('Configuration SMTP incomplète : renseignez SMTP_HOST, SMTP_USER, SMTP_PASS dans le fichier .env');
  }
  return nodemailer.createTransport({
    host, port,
    secure: port === 465,      // 465 = SSL ; 587 = STARTTLS
    auth: { user, pass }
  });
}

/**
 * Envoie le rapport.
 * @param {Object} opts { subject, html, pdfBuffer, pdfName }
 */
async function sendReport({ subject, html, pdfBuffer, pdfName }) {
  const transport = buildTransport();
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const to = (process.env.MAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!to.length) throw new Error('Aucun destinataire : renseignez MAIL_TO dans le fichier .env');

  const info = await transport.sendMail({
    from, to, subject, html,
    attachments: pdfBuffer ? [{ filename: pdfName || 'rapport.pdf', content: pdfBuffer }] : []
  });
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

/** Vérifie que la connexion SMTP fonctionne (utile au démarrage / test config). */
async function verify() {
  const transport = buildTransport();
  await transport.verify();
  return true;
}

/**
 * Construit le corps HTML de l'email à partir de l'interprétation.
 */
function buildEmailHtml(R, day, line, interp, fmtDayFR) {
  const pos = interp.pos;
  const rows = interp.summary.map(s =>
    `<tr><td style="padding:6px 0;color:#132a40">${s.label}</td>
         <td style="padding:6px 0;text-align:right;font-weight:600;color:#1D4370">${s.value}</td></tr>`).join('');
  const paras = interp.paragraphs.map(p =>
    `<p style="margin:0 0 10px;color:#132a40;line-height:1.55">${p}</p>`).join('');
  const flags = interp.flags.length
    ? `<div style="margin:12px 0;padding:10px 14px;background:#fdecec;border:1px solid #f3c9c9;border-radius:8px;color:#B23B3B;font-weight:600;font-size:13px">⚠ ${interp.flags.join(' · ')}</div>`
    : '';

  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto">
    <div style="background:linear-gradient(115deg,#1D4370,#1083B6);padding:22px 24px;border-radius:12px 12px 0 0">
      <div style="color:#fff;font-size:19px;font-weight:800">Bilan Farine — Broyeur Cru</div>
      <div style="color:#cfe0ee;font-size:13px;margin-top:3px">Usine de Tétouan · Ligne ${line} · ${fmtDayFR(day)}</div>
    </div>
    <div style="height:4px;background:linear-gradient(90deg,#04BFF7,#55BE82,#8FC135)"></div>
    <div style="border:1px solid #dbe6ec;border-top:none;border-radius:0 0 12px 12px;padding:24px">
      <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#5d6b73;font-weight:700">Écart de bouclage du bilan</div>
      <div style="font-size:40px;font-weight:800;color:${pos?'#1D4370':'#B23B3B'};line-height:1.1;margin:4px 0">
        ${pos?'+':'−'}${interp.headline.match(/[\d,.]+ %/)[0]}
      </div>
      <div style="font-family:monospace;color:#132a40">${pos?'+':'−'}${interp.summary.find(s=>s.label==='Résidu (T3)').value.replace(/^[+−]/,'')} ${pos?'inexpliquées':'manquantes'}</div>
      ${flags}
      <h3 style="color:#1D4370;margin:22px 0 8px;font-size:15px">Récapitulatif</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>
      <h3 style="color:#1D4370;margin:22px 0 8px;font-size:15px">Interprétation</h3>
      ${paras}
      <p style="margin-top:18px;color:#5d6b73;font-size:12px">Le rapport détaillé est en pièce jointe (PDF). Généré automatiquement — application interne Holcim.</p>
    </div>
  </div>`;
}

module.exports = { sendReport, verify, buildEmailHtml };
