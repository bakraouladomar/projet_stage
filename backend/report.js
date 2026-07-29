'use strict';
/**
 * report.js — Construit l'interprétation en français à partir d'un résultat de calcul,
 * et génère le PDF du rapport (mise en page aux couleurs Holcim).
 */
const PDFDocument = require('pdfkit');

// Couleurs Holcim
const NAVY = '#1D4370', BLUE = '#1083B6', GREEN = '#6FA028', RED = '#B23B3B',
      INK = '#132a40', MUTED = '#5d6b73', LINE = '#dbe6ec';

function fmt(v, d = 1) {
  return v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtDayFR(day) {
  if (!day) return '—';
  const m = String(day).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3])
    .toLocaleDateString('fr-FR', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
  return day;
}

/**
 * Produit les éléments textuels du rapport.
 * @returns { headline, summary:[{label,value}], paragraphs:[...], flags:[...] }
 */
function buildInterpretation(R, day, line) {
  const pos = R.T3 >= 0;
  const siloStuck = (R.nivFirst != null && R.nivLast != null && Math.abs(R.nivLast - R.nivFirst) < 0.1);
  const siloMoved = (R.nivFirst != null && R.nivLast != null && !siloStuck);

  const headline = pos
    ? `Écart de bouclage : +${fmt(R.T2,2)} %  (+${fmt(R.T3)} t inexpliquées)`
    : `Écart de bouclage : −${fmt(Math.abs(R.T2),2)} %  (−${fmt(Math.abs(R.T3))} t manquantes)`;

  const summary = [
    { label: 'Production sèche',        value: `${fmt(R.prodSec,0)} t` },
    { label: 'Consommation four (×'+fmt(R.params.kDos,2)+')', value: `${fmt(R.conso,0)} t` },
    { label: 'Variation stock silo',    value: `${fmt(R.deltaSilo)} t` },
    { label: 'Détourné vers le sol',    value: `${fmt(R.prodSol + R.rejSol)} t` },
    { label: 'Résidu (T3)',             value: `${pos?'+':'−'}${fmt(Math.abs(R.T3))} t` },
    { label: 'SEEC énergie',            value: R.seec != null ? `${fmt(R.seec,2)} kWh/t` : 'n/a' },
    { label: 'Marche broyeur',          value: `${fmt(R.heuresMarche,1)} h` },
    { label: 'Arrêts / démarrages',     value: `${R.arrets} / ${R.dem}` },
    { label: 'Coupures alimentation',   value: `${R.coupures} min` },
  ];

  const paragraphs = [];

  // 1. Sens du résidu
  paragraphs.push(pos
    ? `Le broyeur déclare ${fmt(R.T3)} t de plus que ce que les sorties connues expliquent. Cet excédent correspond soit à un écart de mesure entre les bascules (216 TH 20 en production, 312 DO 12 au four), soit à de la matière réellement accumulée dans le silo mais non vue par le capteur de niveau.`
    : `Le four a consommé ${fmt(Math.abs(R.T3))} t de plus que ce que le broyeur a fabriqué. Ce déficit correspond à un déstockage du silo, ou à un écart de mesure de sens inverse entre les deux bascules.`);

  // 2. État du silo
  if (siloStuck) {
    paragraphs.push(`⚠ Le capteur de niveau du silo est resté figé à ${fmt(R.nivFirst,2)} % toute la journée : la variation de stock n'a pas pu être mesurée (terme à 0 t). Le résidu ci-dessus est donc à interpréter avec prudence — il mélange l'écart de mesure et une variation de stock inconnue.`);
  } else if (siloMoved && R.deltaSilo > 0) {
    paragraphs.push(`Le silo s'est rempli de ${fmt(R.deltaSilo)} t sur la journée (niveau ${fmt(R.nivFirst,2)} % → ${fmt(R.nivLast,2)} %). Cette matière est stockée, elle est déduite du résidu.`);
  } else if (siloMoved) {
    paragraphs.push(`Le silo s'est vidé de ${fmt(Math.abs(R.deltaSilo))} t sur la journée (niveau ${fmt(R.nivFirst,2)} % → ${fmt(R.nivLast,2)} %) : déstockage au profit du four.`);
  }

  // 3. Énergie
  if (R.seec != null) {
    let note = '';
    if (R.seec > 16.5) note = ' — au-dessus de la plage habituelle, à surveiller (charge broyante, finesse, usure).';
    else if (R.seec < 15) note = ' — bonne performance énergétique.';
    paragraphs.push(`Consommation spécifique : ${fmt(R.seec,2)} kWh/t${note} Le broyeur a tourné ${fmt(R.heuresMarche,1)} h, avec ${R.arrets} arrêt(s) et ${R.coupures} min de marche à vide (coupures d'alimentation).`);
  }

  // 4. Rappel méthodologique
  paragraphs.push(`Rappel : le coefficient de correction du doseur four (×${fmt(R.params.kDos,2)}) et la capacité silo (${fmt(R.params.cap,0)} t) sont des hypothèses, pas des mesures. Elles influencent directement le résidu ; à réviser si un étalonnage des bascules est réalisé.`);

  const flags = [];
  if (siloStuck) flags.push('Capteur niveau silo figé');
  if (R.seec != null && R.seec > 16.5) flags.push('SEEC élevé');
  if (R.coupures > 15) flags.push('Coupures d\'alimentation fréquentes');
  if (!pos) flags.push('Bilan en déficit (déstockage)');

  return { headline, pos, summary, paragraphs, flags };
}

/**
 * Génère le PDF du rapport. Renvoie une Promise<Buffer>.
 */
function buildPdf(R, day, line, interp) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width, M = doc.page.margins.left, CW = W - 2*M;
    const pos = interp.pos;

    // -- Bandeau titre --
    doc.rect(0, 0, W, 90).fill(NAVY);
    doc.rect(0, 90, W, 4).fill(GREEN);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(18)
       .text('Bilan Farine — Broyeur Cru', M, 26);
    doc.font('Helvetica').fontSize(10).fillColor('#cfe0ee')
       .text(`Usine de Tétouan · Ligne ${line} · ${fmtDayFR(day)}`, M, 52);

    let y = 120;

    // -- Résultat principal --
    doc.font('Helvetica-Bold').fontSize(11).fillColor(MUTED)
       .text('ÉCART DE BOUCLAGE DU BILAN', M, y);
    y += 18;
    doc.font('Helvetica-Bold').fontSize(30).fillColor(pos ? NAVY : RED)
       .text(`${pos?'+':'−'}${fmt(Math.abs(R.T2),2)} %`, M, y);
    doc.font('Helvetica').fontSize(12).fillColor(INK)
       .text(`${pos?'+':'−'}${fmt(Math.abs(R.T3))} t ${pos?'inexpliquées':'manquantes'}`, M+150, y+12);
    y += 52;

    // -- Alertes éventuelles --
    if (interp.flags.length) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(RED)
         .text('⚠ ' + interp.flags.join('   ·   '), M, y);
      y += 20;
    }

    // -- Tableau récapitulatif --
    doc.moveTo(M, y).lineTo(M+CW, y).strokeColor(LINE).stroke();
    y += 10;
    doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Récapitulatif', M, y);
    y += 20;
    doc.fontSize(10);
    for (const row of interp.summary) {
      doc.font('Helvetica').fillColor(INK).text(row.label, M, y, { width: CW*0.62 });
      doc.font('Helvetica-Bold').fillColor(NAVY).text(row.value, M+CW*0.62, y, { width: CW*0.38, align: 'right' });
      y += 17;
    }
    y += 8;

    // -- Interprétation --
    doc.moveTo(M, y).lineTo(M+CW, y).strokeColor(LINE).stroke();
    y += 10;
    doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Interprétation', M, y);
    y += 18;
    doc.font('Helvetica').fontSize(10).fillColor(INK);
    for (const p of interp.paragraphs) {
      doc.text(p, M, y, { width: CW, align: 'justify', lineGap: 2 });
      y = doc.y + 8;
    }

    // -- Pied --
    const fy = doc.page.height - 60;
    doc.moveTo(M, fy).lineTo(M+CW, fy).strokeColor(LINE).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
       .text(`Rapport généré automatiquement le ${new Date().toLocaleString('fr-FR')} · Application interne Holcim`, M, fy+8);

    doc.end();
  });
}

module.exports = { buildInterpretation, buildPdf, fmtDayFR };
