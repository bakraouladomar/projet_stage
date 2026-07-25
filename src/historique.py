"""
Historique des jours traites, en remplacement du copier-coller manuel
de la feuille 'Suivi Silo Farine' de l'Excel d'origine.

Chaque jour traite ajoute UNE ligne, identifiee par sa date. Si le meme
jour est retraite (fichier corrige, relance...), la ligne est mise a jour
au lieu d'etre dupliquee - ca evite exactement le bug des 25/26 decembre
2023 qu'on avait trouve dans le fichier Excel d'origine.
"""

import csv
import os


CHAMPS = [
    "date",
    "prod_wet_t",
    "humidite_pct",
    "prod_sec_t",
    "conso_farine_brute_t",
    "conso_farine_corrigee_t",
    "delta_silo_t",
    "delta_silo_statut",
    "prod_vers_sol_t",
    "rejets_vers_sol_t",
    "residu_T3_t",
    "residu_T2_pct",
    "capteur_niveau_fiable",
    "capteur_niveau_pct_fige",
    "capteur_niveau_ecart_type",
    "debit_th20_fiable",
    "debit_th20_tonnage_fantome_t",
    "debit_do12_fiable",
    "debit_do12_tonnage_bruit_t",
]


def _charger_lignes_existantes(chemin_csv):
    """Relit l'historique existant, retourne un dict {date: ligne}."""
    if not os.path.exists(chemin_csv):
        return {}
    lignes = {}
    with open(chemin_csv, "r", newline="", encoding="utf-8") as f:
        for ligne in csv.DictReader(f):
            lignes[ligne["date"]] = ligne
    return lignes


def _construire_ligne(date_str, resultat):
    """Aplati le dict de resultat (avec ses sous-diagnostics) en une seule ligne."""
    diag_niv = resultat["diagnostic_capteur_niveau"]
    diag_th20 = resultat["diagnostic_debit_th20"]
    diag_do12 = resultat["diagnostic_debit_do12"]

    return {
        "date": date_str,
        "prod_wet_t": resultat["prod_wet_t"],
        "humidite_pct": resultat["humidite_pct"],
        "prod_sec_t": resultat["prod_sec_t"],
        "conso_farine_brute_t": resultat["conso_farine_brute_t"],
        "conso_farine_corrigee_t": resultat["conso_farine_corrigee_t"],
        "delta_silo_t": resultat["delta_silo_t"],
        "delta_silo_statut": resultat["delta_silo_statut"],
        "prod_vers_sol_t": resultat["prod_vers_sol_t"],
        "rejets_vers_sol_t": resultat["rejets_vers_sol_t"],
        "residu_T3_t": resultat["residu_T3_t"],
        "residu_T2_pct": resultat["residu_T2_pct"],
        "capteur_niveau_fiable": diag_niv["fiable"],
        "capteur_niveau_pct_fige": diag_niv["pct_minutes_figees"],
        "capteur_niveau_ecart_type": diag_niv["ecart_type"],
        "debit_th20_fiable": diag_th20["fiable"],
        "debit_th20_tonnage_fantome_t": diag_th20["tonnage_fantome_t"],
        "debit_do12_fiable": diag_do12["fiable"],
        "debit_do12_tonnage_bruit_t": diag_do12["tonnage_bruit_t"],
    }


def enregistrer_resultat(chemin_csv, date_str, resultat):
    """
    Ajoute ou met a jour la ligne du jour `date_str` dans l'historique CSV.
    Retourne True si ce jour existait deja (mise a jour), False si c'est
    un nouvel ajout.
    """
    lignes = _charger_lignes_existantes(chemin_csv)
    deja_present = date_str in lignes

    lignes[date_str] = _construire_ligne(date_str, resultat)

    # On reecrit le fichier en entier, trie par date - le nombre de jours
    # traites reste petit (quelques centaines par an maximum), donc le cout
    # de reecriture est negligeable et ca garantit un fichier toujours propre.
    with open(chemin_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CHAMPS)
        writer.writeheader()
        for date_cle in sorted(lignes.keys()):
            writer.writerow(lignes[date_cle])

    return deja_present


def lire_historique(chemin_csv):
    """Retourne la liste des lignes de l'historique, triees par date."""
    lignes = _charger_lignes_existantes(chemin_csv)
    return [lignes[d] for d in sorted(lignes.keys())]