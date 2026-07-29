'use strict';
/**
 * server.js — API du bilan farine.
 *
 * Routes :
 *   POST /api/bilan      (multipart) -> parse le fichier, calcule, renvoie JSON
 *   POST /api/recompute  (JSON)      -> recalcule sans re-téléverser
 *   POST /api/send-now   (multipart) -> génère + envoie le rapport par email (test manuel)
 *   GET  /api/mail-status            -> état de la configuration SMTP
 *   GET  /                           -> sert le frontend
 * Au démarrage : lance l'envoi programmé quotidien (voir scheduler.js).
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { aggregate, finalize, DEFAULT_PARAMS } = require('./calc');
const { startScheduler, runPipeline, runScheduled, latestInboxFile } = require('./scheduler');
const { verify: verifySmtp } = require('./mailer');
const history = require('./history');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25 Mo max
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

/* -- Extrait les données utiles d'un classeur .xlsx -- */
function readWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const shName = wb.SheetNames.find(n => /donn.*tis|tis/i.test(n)) || wb.SheetNames[0];
  const ws = wb.Sheets[shName];
  const arr = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });

  // Ligne 0 = en-têtes ; lignes 1,2 = tag + unité ; données à partir de l'index 3.
  const headers = (arr[0] || []).map(h => (h == null ? '' : String(h).trim()));
  const idx = {};
  headers.forEach((h, i) => { if (h) idx[h] = i; });

  const rows = [];
  for (let r = 3; r < arr.length; r++) {
    const row = arr[r];
    if (!row) continue;
    const first = row[0];
    if (first == null) continue;
    const s = String(first).toLowerCase();
    if (s.includes('sum') || s.includes('avg') || s.includes('somme') || s.includes('moy')) continue;
    rows.push(row);
  }
  return { idx, rows, sheet: shName };
}

/* -- Formate la date de la première ligne -- */
function firstDay(rows) {
  const v = rows[0] && rows[0][0];
  if (v == null) return null;
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return d.toISOString().slice(0, 10);
  }
  return String(v).split(' ')[0];
}

/* ---- POST /api/bilan : upload + calcul complet ---- */
app.post('/api/bilan', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu (champ "file").' });

    const { idx, rows } = readWorkbook(req.file.buffer);
    if (!rows.length) return res.status(422).json({ error: 'Aucune ligne de données exploitable.' });

    const line = (req.body.line || 'BC1').toUpperCase();
    const params = {
      h2o:  num(req.body.h2o,  DEFAULT_PARAMS.h2o),
      kDos: num(req.body.kDos, DEFAULT_PARAMS.kDos),
      cap:  num(req.body.cap,  DEFAULT_PARAMS.cap),
    };

    const aggregates = aggregate(rows, idx, line);
    const result = finalize(aggregates, params);
    const day = firstDay(rows);

    // Cumul : chaque journée traitée s'ajoute (ou se met à jour) dans l'historique.
    let hist = [];
    if (day) {
      hist = history.upsert({
        day, line, T2: result.T2, T3: result.T3, prodSec: result.prodSec,
        seec: result.seec, heuresMarche: result.heuresMarche, arrets: result.arrets,
      });
    }

    res.json({ day, line, aggregates, result, history: hist });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

/* ---- Historique multi-jours ---- */
app.get('/api/history', (req, res) => {
  res.json({ history: history.getAll(req.query.line ? req.query.line.toUpperCase() : null) });
});
app.delete('/api/history', (req, res) => {
  if (req.query.day && req.query.line) return res.json({ history: history.remove(req.query.day, req.query.line.toUpperCase()) });
  res.json({ history: history.clear() });
});

/* ---- POST /api/recompute : nouveau calcul sans re-upload ---- */
app.post('/api/recompute', (req, res) => {
  try {
    const { aggregates, params } = req.body || {};
    if (!aggregates) return res.status(400).json({ error: 'aggregates manquant.' });
    res.json({ result: finalize(aggregates, params) });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

function num(v, def) { const n = parseFloat(v); return isFinite(n) ? n : def; }

/* ---- POST /api/send-now : génère et envoie le rapport immédiatement (test) ---- */
app.post('/api/send-now', upload.single('file'), async (req, res) => {
  try {
    let buffer;
    if (req.file) buffer = req.file.buffer;
    else {
      const f = latestInboxFile();
      if (!f) return res.status(400).json({ error: 'Aucun fichier fourni et data/inbox/ est vide.' });
      buffer = fs.readFileSync(f);
    }
    const line = (req.body.line || process.env.DEFAULT_LINE || 'BC1').toUpperCase();
    const params = {
      h2o:  num(req.body.h2o,  DEFAULT_PARAMS.h2o),
      kDos: num(req.body.kDos, DEFAULT_PARAMS.kDos),
      cap:  num(req.body.cap,  DEFAULT_PARAMS.cap),
    };
    const out = await runPipeline(buffer, line, params);
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

/* ---- GET /api/mail-status : la config SMTP est-elle prête ? ---- */
app.get('/api/mail-status', async (_req, res) => {
  const configured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.MAIL_TO);
  if (!configured) return res.json({ configured: false, verified: false, message: 'SMTP non configuré (.env).' });
  try { await verifySmtp(); res.json({ configured: true, verified: true }); }
  catch (err) { res.json({ configured: true, verified: false, message: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bilan Farine — serveur démarré sur http://localhost:${PORT}`);
  startScheduler();
});
