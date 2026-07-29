'use strict';
/* Test rapide : lit un fichier .xlsx passé en argument et affiche le résultat.
   Usage : node test.js /chemin/vers/export_TIS.xlsx [BC1|BC2] */
const fs = require('fs');
const XLSX = require('xlsx');
const { aggregate, finalize } = require('./calc');

const file = process.argv[2];
const line = (process.argv[3] || 'BC1').toUpperCase();
if (!file) { console.error('Usage: node test.js <fichier.xlsx> [BC1|BC2]'); process.exit(1); }

const wb = XLSX.read(fs.readFileSync(file));
const shName = wb.SheetNames.find(n => /tis/i.test(n)) || wb.SheetNames[0];
const arr = XLSX.utils.sheet_to_json(wb.Sheets[shName], { header: 1, raw: true });
const headers = (arr[0] || []).map(h => h == null ? '' : String(h).trim());
const idx = {}; headers.forEach((h, i) => { if (h) idx[h] = i; });
const rows = [];
for (let r = 3; r < arr.length; r++) {
  const row = arr[r]; if (!row || row[0] == null) continue;
  const s = String(row[0]).toLowerCase();
  if (s.includes('sum') || s.includes('avg')) continue;
  rows.push(row);
}

const agg = aggregate(rows, idx, line);
const res = finalize(agg, { h2o: 2.80, kDos: 0.90, cap: 1200 });

console.log(`Ligne ${line} — ${rows.length} minutes`);
console.log('  prod humide  :', res.prodWet.toFixed(2), 't');
console.log('  prod sèche   :', res.prodSec.toFixed(2), 't');
console.log('  conso four   :', res.conso.toFixed(2), 't');
console.log('  delta silo   :', res.deltaSilo.toFixed(2), 't');
console.log('  vers sol     :', (res.prodSol + res.rejSol).toFixed(2), 't');
console.log('  --------------------------------');
console.log('  T3 (résidu)  :', res.T3.toFixed(2), 't');
console.log('  T2 (écart)   :', res.T2.toFixed(3), '%');
console.log('  SEEC         :', res.seec != null ? res.seec.toFixed(2) + ' kWh/t' : 'n/a');
console.log('  marche       :', res.heuresMarche.toFixed(2), 'h |', res.arrets, 'arrêts,', res.dem, 'démarrages,', res.coupures, 'min coupure');
