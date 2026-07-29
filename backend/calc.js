'use strict';
/**
 * calc.js — Moteur de calcul du bilan farine (broyeur cru Tétouan).
 *
 * Deux fonctions :
 *   aggregate(rows, idx, line)  -> parcourt les 1440 minutes une seule fois
 *                                  et renvoie les sommes brutes (indépendantes des hypothèses)
 *   finalize(aggregates, params) -> applique les hypothèses (humidité, correction doseur,
 *                                  capacité silo) et renvoie le résultat final (T3, T2, SEEC...)
 *
 * Séparer les deux permet au frontend de recalculer instantanément quand on change
 * un paramètre, sans re-téléverser le fichier.
 */

// Colonnes du TIS par ligne broyeur.
// Chaque champ accepte PLUSIEURS noms possibles : le nom lisible ET le tag automate
// brut (format export TIS quotidien). aggregate() prend le premier nom trouvé.
const COLS = {
  BC1: {
    debit:  ['Débit total TH20', 'TET.331-BC01.F01:PV'],
    pw:     ['Pw Mot Br', 'TET.361-RM01.J01:PV'],
    kwh:    ['Clle_BC1', 'TET.3P1-1W01.J01:PVC'],
    ajouts: ['Clle Ajouts BK2', 'TET.2P1-1W01.J02:PVC'],
    dos:    ['Débit Dos Farine', 'TET.431-BE01.F01:PV'],
    vo18:   ['Position ON VO18', 'TET.431-BE01.X02:X'],
    rejet:  ['Débit rejet', 'TET.361-WF01.F01:PV'],
    rejetSol:['Rejet vers Sol', 'TET.361-BF02.V01:Y'],
    alimSol:['Alim vers Sol', 'TET.331-BC01.V01:X'],
    niv:    ['Niv Silo Farine 1', 'TET.391-3S01.L01:PV'],
  },
  BC2: {
    debit:'Débit tot BC2', pw:'Pw active mot BC2', kwh:'Clle BC2', ajouts:'Clle Ajout L2',
    dos:'Débit dos Farine L2', vo18:'Pos ON VO18 L2', rejet:'Débit rejet BC2',
    rejetSol:null, alimSol:'Alim vers Sol BC2', niv:'Niv silo Farine 2'
  }
};

// Résout l'index d'une colonne à partir d'un nom OU d'une liste de noms possibles.
function resolveCol(idx, names) {
  if (names == null) return null;
  const list = Array.isArray(names) ? names : [names];
  for (const n of list) if (idx[n] != null) return idx[n];
  return null;
}

// Recette du mélange cru (mêmes valeurs que le fichier Suivi Silo Farine).
// L'humidité pondérée en découle : Σ(part% × H2O%) / 100.
const RECETTE_DEFAUT = {
  BC1: [
    { nom:'BT',              part:43.67, h2o:2.25 },
    { nom:'HT',              part:43.38, h2o:2.04 },
    { nom:'Pélite',          part:9.33,  h2o:7.44 },
    { nom:'Phtanite',        part:2.58,  h2o:6.81 },
    { nom:'Minerai de Fer',  part:1.04,  h2o:6.13 },
  ],
  BC2: [
    { nom:'BT',              part:37.42, h2o:2.50 },
    { nom:'HT',              part:48.34, h2o:1.50 },
    { nom:'Pélite',          part:6.87,  h2o:8.00 },
    { nom:'Phtanite',        part:5.66,  h2o:7.00 },
    { nom:'Minerai de Fer',  part:1.70,  h2o:6.50 },
  ],
};

// Humidité pondérée (%) à partir d'une recette.
function humiditeRecette(recette) {
  if (!recette || !recette.length) return null;
  const somme = recette.reduce((a, c) => a + (c.part * c.h2o), 0);
  return somme / 100; // en %
}

const DEFAULT_PARAMS = { h2o: 2.80, kDos: 0.90, cap: 1200, kAjouts: 0.85 };

function toNum(v){
  if (v == null) return null;
  const n = (typeof v === 'number') ? v : parseFloat(String(v).replace(',', '.'));
  return isFinite(n) ? n : null;
}

/**
 * Parcourt les lignes de données (déjà nettoyées des en-têtes et des totaux Sum/Avg)
 * et cumule tout ce qui ne dépend pas des hypothèses.
 * @param {Array<Array>} rows  lignes de données brutes
 * @param {Object} idx         { nomColonne: indexColonne }
 * @param {string} line        'BC1' | 'BC2'
 */
function aggregate(rows, idx, line) {
  const c = COLS[line];
  const iDeb = resolveCol(idx, c && c.debit);
  if (!c || iDeb == null) {
    throw new Error(`Ligne ${line} absente du fichier (colonne débit introuvable, ni nom lisible ni tag TIS).`);
  }
  const iPw = resolveCol(idx, c.pw), iDos = resolveCol(idx, c.dos), iVo = resolveCol(idx, c.vo18),
        iRej = resolveCol(idx, c.rejet), iAlS = resolveCol(idx, c.alimSol),
        iReS = resolveCol(idx, c.rejetSol),
        iNiv = resolveCol(idx, c.niv), iKwh = resolveCol(idx, c.kwh), iAj = resolveCol(idx, c.ajouts);

  let sDeb=0, sDos=0, sProdSol=0, sRejSol=0, nMin=0;
  let nivFirst=null, nivLast=null;
  let minMarche=0, arrets=0, dem=0, coupures=0, runPrev=null;
  let sKwh=0, sAj=0, hasKwh=false, hasAj=false;
  const hourTons = new Array(24).fill(0); // production humide (t) par heure de la journée
  // --- compteurs de fiabilité (diagnostics capteurs) ---
  const nivVals=[]; let nivFige=0, nivPrev=null;          // capteur niveau silo
  let debVideEnMarche=0, tonnageFantome=0, debAberrantes=0; // bascule TH20
  let dosBruit=0, dosVideVoletOuvert=0, dosAberrantes=0;    // doseur four
  // --- durée des arrêts broyeur ---
  const arretsListe = [];          // { debutMin, dureeMin }
  let arretEnCours = null;         // index minute de début de l'arrêt courant
  let rowIndex = -1;

  for (const row of rows) {
    const deb = toNum(row[iDeb]);
    const pw  = iPw  != null ? toNum(row[iPw])  : null;
    const dos = iDos != null ? toNum(row[iDos]) : null;
    const vo  = iVo  != null ? toNum(row[iVo])  : null;
    const niv = iNiv != null ? toNum(row[iNiv]) : null;
    nMin++;
    rowIndex++;

    if (deb != null) sDeb += deb;

    // Profil horaire : production humide (t) cumulée par heure de la journée.
    if (deb != null) {
      let h = null;
      const ts = row[0];
      if (typeof ts === 'number') {                 // date sérielle Excel
        h = Math.floor(((ts % 1) * 24)) % 24;
      } else if (ts != null) {                        // texte "... HH:MM"
        const m = String(ts).match(/(\d{1,2}):(\d{2})/);
        if (m) h = parseInt(m[1], 10) % 24;
      }
      if (h == null) h = Math.floor(rowIndex / 60) % 24; // repli : index minute
      hourTons[h] += deb / 60;
    }

    // Consommation four : le débit doseur ne compte que si le volet VO18 est ouvert.
    if (dos != null && (vo == null || vo !== 0)) sDos += dos;

    // Production détournée vers le sol : vanne alim/sol ouverte ET débit significatif.
    if (iAlS != null) { const a = toNum(row[iAlS]); if (a && deb != null && deb > 10) sProdSol += deb; }

    // Rejets vers le sol : broyeur non alimenté ET vanne rejets/sol ouverte.
    if (iReS != null) { const rs = toNum(row[iReS]); const rj = toNum(row[iRej]);
      if (rs && rj != null && (deb == null || deb < 10)) sRejSol += rj; }

    // Niveau silo : première et dernière lecture valide.
    if (niv != null) { if (nivFirst == null) nivFirst = niv; nivLast = niv; }

    // --- Diagnostics de fiabilité (traduits du moteur Python) ---
    const PLAFOND = 250, SEUIL_DEB = 10, SEUIL_PW_BC = 8;
    // capteur niveau : minutes figées (valeur identique à la précédente)
    if (niv != null) {
      if (nivPrev != null && niv === nivPrev) nivFige++;
      nivVals.push(niv); nivPrev = niv;
      if (niv < 0 || niv > 150) {/* niveau % aberrant ignoré ici */}
    }
    // bascule TH20 : minute vide pendant la marche + tonnage fantôme + aberrantes
    if (deb == null && pw != null && pw > SEUIL_PW_BC) debVideEnMarche++;
    if (deb != null && deb > SEUIL_DEB && pw != null && pw <= SEUIL_PW_BC) tonnageFantome += deb / 60;
    if (deb != null && (deb < 0 || deb > PLAFOND)) debAberrantes++;
    // doseur four : bruit volet fermé + trou volet ouvert + aberrantes
    if ((vo == null || vo === 0) && dos != null && dos > 0.01) dosBruit++;
    if (vo != null && vo !== 0 && dos == null) dosVideVoletOuvert++;
    if (dos != null && (dos < 0 || dos > PLAFOND)) dosAberrantes++;

    // Compteurs kWh : consommation par minute -> on somme.
    if (iKwh != null) { const k = toNum(row[iKwh]); if (k != null){ sKwh += k; hasKwh = true; } }
    if (iAj  != null) { const a = toNum(row[iAj]);  if (a != null){ sAj  += a; hasAj  = true; } }

    // États de marche (Pw moteur > 8 kW), arrêts/démarrages, coupures d'alimentation.
    if (pw != null) {
      const run = pw > 8;
      if (run) minMarche++;
      if (runPrev !== null) {
        if (runPrev && !run) { arrets++; arretEnCours = rowIndex; }       // début d'arrêt
        if (!runPrev && run) {                                            // fin d'arrêt
          dem++;
          if (arretEnCours != null) {
            arretsListe.push({ debutMin: arretEnCours, dureeMin: rowIndex - arretEnCours });
            arretEnCours = null;
          }
        }
      }
      if (pw > 5 && deb != null && deb < 50) coupures++; // tourne mais plus alimenté
      runPrev = run;
    }
  }
  // Arrêt encore en cours à la fin de la journée (le broyeur n'a pas redémarré).
  if (arretEnCours != null) {
    arretsListe.push({ debutMin: arretEnCours, dureeMin: rowIndex - arretEnCours + 1 });
  }

  const kwh    = hasKwh ? sKwh : null;
  const ajouts = hasAj  ? sAj  : null;

  // --- Verdict de fiabilité des 3 capteurs racines ---
  const SEUIL_ECART_TYPE = 0.5;   // % — variation minimale du niveau sur la journée
  const SEUIL_PCT_FIGE   = 70;    // % — au-delà, capteur considéré comme figé
  const nNiv = nivVals.length;
  let ecartType = null, pctFige = null, nivFiable = false, nivRaison = 'moins de 2 valeurs';
  if (nNiv >= 2) {
    const moy = nivVals.reduce((a,b)=>a+b,0)/nNiv;
    ecartType = Math.sqrt(nivVals.reduce((a,b)=>a+(b-moy)*(b-moy),0)/nNiv);
    pctFige = Math.round(1000*nivFige/(nNiv-1))/10;
    const bougeAssez = ecartType >= SEUIL_ECART_TYPE;
    const pasFige = pctFige <= SEUIL_PCT_FIGE;
    nivFiable = bougeAssez && pasFige;
    nivRaison = nivFiable ? null
      : (!bougeAssez ? `variation ${ecartType.toFixed(2)} % < seuil ${SEUIL_ECART_TYPE} %`
                     : `${pctFige} % des minutes figées > ${SEUIL_PCT_FIGE} %`);
  }
  const th20Fiable = (debVideEnMarche === 0 && debAberrantes === 0);
  const do12Fiable = (dosVideVoletOuvert === 0 && dosAberrantes === 0);

  const diagnostics = {
    niveau: { fiable: nivFiable, raison: nivRaison,
              ecartType: ecartType!=null?Math.round(ecartType*1000)/1000:null,
              pctFige, nivDebut: nivFirst, nivFin: nivLast },
    th20:   { fiable: th20Fiable, minutesVidesEnMarche: debVideEnMarche,
              tonnageFantome: Math.round(tonnageFantome*10)/10, aberrantes: debAberrantes },
    do12:   { fiable: do12Fiable, bruitVoletFerme: dosBruit,
              minutesVidesVoletOuvert: dosVideVoletOuvert, aberrantes: dosAberrantes },
    // fiabilité globale : le niveau silo est décisif (il pilote le delta stock)
    global: nivFiable && th20Fiable && do12Fiable,
  };

  // --- Statistiques des arrêts ---
  const dureeMax = arretsListe.reduce((m, a) => Math.max(m, a.dureeMin), 0);
  const dureeTotale = arretsListe.reduce((s, a) => s + a.dureeMin, 0);
  const minToHHMM = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
  const arretsStats = {
    nombre: arretsListe.length,
    dureeMaxMin: dureeMax,
    dureeTotaleMin: dureeTotale,
    // détail : heure de début (à partir de l'index minute) + durée
    details: arretsListe.map(a => ({
      debut: minToHHMM(a.debutMin),
      fin: minToHHMM(a.debutMin + a.dureeMin),
      dureeMin: a.dureeMin,
    })),
  };

  return { line, nMin, sDeb, sDos, sProdSol, sRejSol,
           nivFirst, nivLast, minMarche, arrets, dem, coupures, kwh, ajouts,
           hourTons: hourTons.map(v => Math.round(v * 10) / 10),
           diagnostics, arretsStats };
}

/**
 * Applique les hypothèses aux sommes brutes et renvoie le résultat final.
 * @param {Object} agg     sortie de aggregate()
 * @param {Object} params  { h2o (%), kDos, cap (t), kAjouts }
 */
function finalize(agg, params) {
  const p = Object.assign({}, DEFAULT_PARAMS, params || {});

  // Humidité : si une recette est fournie (params.recette ou recette par défaut de
  // la ligne), on la calcule depuis la composition du mélange (comme le fichier
  // Suivi Silo Farine). Sinon on retombe sur p.h2o.
  const recette = (params && params.recette) || RECETTE_DEFAUT[agg.line] || null;
  const h2oRecette = humiditeRecette(recette);          // en % ou null
  const h2oPct = (h2oRecette != null) ? h2oRecette : p.h2o;
  const H2O = h2oPct / 100;
  const perPoint = p.cap / 100;

  const prodWet   = agg.sDeb / 60;
  const prodSec   = prodWet * (1 - H2O);
  const conso     = (agg.sDos / 60) * p.kDos;
  const deltaSilo = (agg.nivFirst != null && agg.nivLast != null)
                    ? (agg.nivLast - agg.nivFirst) * perPoint : 0;
  const prodSol   = agg.sProdSol / 60;
  const rejSol    = agg.sRejSol / 60;

  const T3 = prodSec - conso - deltaSilo - prodSol - rejSol;
  const T2 = prodSec > 0 ? (T3 / prodSec) * 100 : 0;

  const seec = (agg.kwh != null && prodSec > 0)
               ? (agg.kwh + p.kAjouts * (agg.ajouts || 0)) / prodSec : null;
  const debitMoyen = agg.minMarche > 0 ? prodWet / (agg.minMarche / 60) : null;

  return {
    params: p,
    h2oPct, recette,                          // humidité calculée (%) + recette utilisée
    prodWet, prodSec, conso, deltaSilo, prodSol, rejSol,
    consoBrute: agg.sDos / 60,
    T3, T2, seec, debitMoyen,
    heuresMarche: agg.minMarche / 60,
    arrets: agg.arrets, dem: agg.dem, coupures: agg.coupures,
    arretsStats: agg.arretsStats || null,     // durée max + détail des arrêts
    nivFirst: agg.nivFirst, nivLast: agg.nivLast,
    hourTons: agg.hourTons || null,
    diagnostics: agg.diagnostics || null,
    // Statut du delta silo : "mesure" si capteur fiable, sinon "indéterminé"
    deltaSiloStatut: (agg.diagnostics && agg.diagnostics.niveau.fiable) ? 'mesure' : 'indéterminé'
  };
}

module.exports = { COLS, DEFAULT_PARAMS, aggregate, finalize, toNum };