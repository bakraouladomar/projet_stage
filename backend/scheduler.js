'use strict';
/**
 * scheduler.js — Pipeline « fichier → calcul → rapport → email » + planification.
 *
 * Envoi programmé : chaque jour à l'heure fixée (SCHEDULE_CRON), le serveur prend
 * le dernier fichier .xlsx déposé dans data/inbox/, calcule, génère le PDF + le
 * corps HTML, et envoie l'email aux destinataires (MAIL_TO).
 */
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const XLSX = require('xlsx');
const { aggregate, finalize, DEFAULT_PARAMS } = require('./calc');
const { buildInterpretation, buildPdf, fmtDayFR } = require('./report');
const { sendReport, buildEmailHtml } = require('./mailer');

const INBOX = path.join(__dirname, 'data', 'inbox');

/* -- Lecture d'un classeur (même logique que server.js) -- */
function readWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const shName = wb.SheetNames.find(n => /donn.*tis|tis/i.test(n)) || wb.SheetNames[0];
  const arr = XLSX.utils.sheet_to_json(wb.Sheets[shName], { header: 1, raw: true });
  const headers = (arr[0] || []).map(h => (h == null ? '' : String(h).trim()));
  const idx = {}; headers.forEach((h, i) => { if (h) idx[h] = i; });
  const rows = [];
  for (let r = 3; r < arr.length; r++) {
    const row = arr[r]; if (!row || row[0] == null) continue;
    const s = String(row[0]).toLowerCase();
    if (s.includes('sum') || s.includes('avg') || s.includes('somme') || s.includes('moy')) continue;
    rows.push(row);
  }
  return { idx, rows };
}
function firstDay(rows) {
  const v = rows[0] && rows[0][0];
  if (v == null) return null;
  if (typeof v === 'number') return new Date(Math.round((v-25569)*86400*1000)).toISOString().slice(0,10);
  return String(v).split(' ')[0];
}

/** Dernier .xlsx déposé dans le dossier inbox. */
function latestInboxFile() {
  if (!fs.existsSync(INBOX)) return null;
  const files = fs.readdirSync(INBOX)
    .filter(f => /\.xlsx?$/i.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(INBOX, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(INBOX, files[0].f) : null;
}

/**
 * Exécute le pipeline complet sur un buffer de fichier donné.
 * @param {Buffer} buffer  contenu du .xlsx
 * @param {string} line    'BC1' | 'BC2'
 * @param {Object} params  hypothèses (sinon défauts)
 * @returns résultat de l'envoi
 */
async function runPipeline(buffer, line = 'BC1', params = {}) {
  const { idx, rows } = readWorkbook(buffer);
  if (!rows.length) throw new Error('Fichier sans données exploitables.');
  const p = Object.assign({}, DEFAULT_PARAMS, params);
  const agg = aggregate(rows, idx, line);
  const result = finalize(agg, p);
  const day = firstDay(rows);

  const interp = buildInterpretation(result, day, line);
  const pdf = await buildPdf(result, day, line, interp);
  const html = buildEmailHtml(result, day, line, interp, fmtDayFR);

  const subject = `Bilan Farine ${line} — ${fmtDayFR(day)} — ${interp.pos?'+':'−'}${Math.abs(result.T2).toFixed(1).replace('.',',')} %`;
  const send = await sendReport({
    subject, html, pdfBuffer: pdf,
    pdfName: `Bilan_Farine_${line}_${day || 'jour'}.pdf`
  });
  return { day, line, T2: result.T2, T3: result.T3, ...send };
}

/** Tâche programmée : prend le dernier fichier de l'inbox et envoie le rapport. */
async function runScheduled() {
  const file = latestInboxFile();
  if (!file) { console.warn('[scheduler] Aucun fichier dans data/inbox/ — envoi ignoré.'); return; }
  console.log('[scheduler] Traitement de', path.basename(file));
  try {
    const buffer = fs.readFileSync(file);
    const line = process.env.DEFAULT_LINE || 'BC1';
    const res = await runPipeline(buffer, line);
    console.log('[scheduler] Rapport envoyé :', res.accepted, '| T2', res.T2.toFixed(2), '%');
  } catch (err) {
    console.error('[scheduler] Échec :', err.message);
  }
}

/** Démarre la planification (appelé au boot du serveur). */
function startScheduler() {
  const expr = process.env.SCHEDULE_CRON || '0 6 * * *'; // 06:00 chaque jour par défaut
  if (!cron.validate(expr)) { console.error('[scheduler] SCHEDULE_CRON invalide :', expr); return; }
  cron.schedule(expr, runScheduled, { timezone: process.env.TZ || 'Africa/Casablanca' });
  console.log(`[scheduler] Envoi programmé actif — planning « ${expr} » (fuseau ${process.env.TZ || 'Africa/Casablanca'}).`);
}

module.exports = { runPipeline, runScheduled, startScheduler, latestInboxFile };
