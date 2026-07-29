'use strict';
/**
 * history.js — Historique cumulatif des journées traitées.
 *
 * Chaque journée calculée peut être enregistrée ici ; l'historique persiste
 * dans data/historique.json et sert à tracer l'évolution jour par jour
 * (écart de bouclage %, production sèche t, etc.).
 *
 * Clé d'une entrée = jour + ligne (ex. "2026-07-16|BC1"), pour qu'un même
 * jour ne soit pas compté deux fois et qu'un recalcul écrase l'ancien.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'historique.json');

function ensureDir() {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  try {
    if (!fs.existsSync(FILE)) return [];
    const raw = fs.readFileSync(FILE, 'utf8').trim();
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function save(list) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8');
}

/** Ajoute (ou met à jour) une journée dans l'historique, puis renvoie la liste triée. */
function upsert(entry) {
  const list = load();
  const key = `${entry.day}|${entry.line}`;
  const i = list.findIndex(e => `${e.day}|${e.line}` === key);
  const clean = {
    day: entry.day,
    line: entry.line,
    T2: round(entry.T2, 2),
    T3: round(entry.T3, 1),
    prodSec: round(entry.prodSec, 0),
    seec: entry.seec != null ? round(entry.seec, 2) : null,
    heuresMarche: round(entry.heuresMarche, 1),
    arrets: entry.arrets,
    savedAt: new Date().toISOString(),
  };
  if (i >= 0) list[i] = clean; else list.push(clean);
  list.sort((a, b) => String(a.day).localeCompare(String(b.day)));
  save(list);
  return list;
}

/** Renvoie l'historique, éventuellement filtré par ligne. */
function getAll(line) {
  const list = load();
  return line ? list.filter(e => e.line === line) : list;
}

/** Supprime une journée précise (day+line). */
function remove(day, line) {
  const list = load().filter(e => !(e.day === day && e.line === line));
  save(list);
  return list;
}

/** Vide tout l'historique. */
function clear() { save([]); return []; }

function round(v, d) {
  if (v == null || isNaN(v)) return v;
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

module.exports = { upsert, getAll, remove, clear };
