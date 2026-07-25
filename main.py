"""
Point d'entree : traite un export TIS quotidien et affiche le bilan
matiere avec diagnostics de fiabilite sur les variables racines.

Usage :
    python main.py chemin/vers/export_du_jour.xlsx
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

from lecture_tis import lire_export_tis
from diagnostics import charger_config, calculer_bilan
from historique import enregistrer_resultat, lire_historique


def main():
    if len(sys.argv) < 2:
        print("Usage : python main.py chemin/vers/export_tis.xlsx")
        sys.exit(1)

    chemin_export = sys.argv[1]
    base_dir = os.path.dirname(__file__)
    chemin_coeffs = os.path.join(base_dir, "config", "coefficients.yaml")
    chemin_recette = os.path.join(base_dir, "config", "recette_labo.yaml")

    print(f"Lecture de l'export TIS : {chemin_export}")
    donnees = lire_export_tis(chemin_export)
    print(f"  -> {len(donnees['debit_th20'])} minutes lues.")

    coeffs, recette = charger_config(chemin_coeffs, chemin_recette)
    print(f"  -> recette labo du {recette.get('date_derniere_analyse_labo', '?')}")

    resultat = calculer_bilan(donnees, coeffs, recette["BC1"])

    print("\n" + "=" * 60)
    print("BILAN MATIERE BC1")
    print("=" * 60)
    print(f"Production humide       : {resultat['prod_wet_t']:>10} t")
    print(f"Humidite melange         : {resultat['humidite_pct']:>10} %")
    print(f"Production seche         : {resultat['prod_sec_t']:>10} t")
    print(f"Conso four (brute)       : {resultat['conso_farine_brute_t']:>10} t")
    print(f"Conso four (x{resultat['correction_doseur_four']})     : {resultat['conso_farine_corrigee_t']:>10} t")
    print(f"Delta silo               : {resultat['delta_silo_t']:>10} t  [{resultat['delta_silo_statut']}]")
    print(f"Production vers sol      : {resultat['prod_vers_sol_t']:>10} t")
    print(f"Rejets vers sol          : {resultat['rejets_vers_sol_t']:>10} t")
    print("-" * 60)
    print(f"RESIDU T3                : {resultat['residu_T3_t']:>10} t")
    print(f"RESIDU T2                : {resultat['residu_T2_pct']:>10} %")
    print("=" * 60)

    diag = resultat["diagnostic_capteur_niveau"]
    print("\nDIAGNOSTIC CAPTEUR NIVEAU SILO (variable racine la plus fragile)")
    print(f"  Fiable                 : {diag['fiable']}")
    if not diag["fiable"]:
        print(f"  Raison                 : {diag['raison']}")
    print(f"  Ecart-type sur la journee : {diag['ecart_type']}")
    print(f"  % minutes figees (valeur identique a la precedente) : {diag['pct_minutes_figees']}%")

    diag_th20 = resultat["diagnostic_debit_th20"]
    print("\nDIAGNOSTIC DEBIT TH20 (entree broyeur)")
    print(f"  Fiable                 : {diag_th20['fiable']}")
    print(f"  Minutes vides pendant marche (donnee manquante anormale) : {diag_th20['minutes_vides_en_marche']}")
    print(f"  Tonnage 'fantome' (debit>0 alors que moteur < seuil)    : {diag_th20['tonnage_fantome_t']} t sur {diag_th20['minutes_fantome']} min")
    print(f"  Valeurs aberrantes (negatives ou > plafond)             : {diag_th20['n_valeurs_aberrantes']}")

    diag_do12 = resultat["diagnostic_debit_do12"]
    print("\nDIAGNOSTIC DEBIT DO12 (doseur four)")
    print(f"  Fiable                 : {diag_do12['fiable']}")
    print(f"  Minutes de bruit (volet ferme, debit>0 quand meme)      : {diag_do12['minutes_bruit_volet_ferme']} ({diag_do12['tonnage_bruit_t']} t)")
    print(f"  Minutes vides pendant que le volet est ouvert           : {diag_do12['minutes_vides_volet_ouvert']}")
    print(f"  Valeurs aberrantes (negatives ou > plafond)             : {diag_do12['n_valeurs_aberrantes']}")

    # ---- Sauvegarde automatique dans l'historique ----
    chemin_historique = os.path.join(base_dir, "historique_silo_farine.csv")
    date_journee = donnees.get("_date_journee")
    date_str = str(date_journee) if date_journee else "date_inconnue"

    deja_present = enregistrer_resultat(chemin_historique, date_str, resultat)

    print("\n" + "=" * 60)
    if deja_present:
        print(f"[HISTORIQUE] Jour {date_str} deja present -> ligne mise a jour (pas de doublon).")
    else:
        print(f"[HISTORIQUE] Jour {date_str} ajoute a l'historique.")
    nb_jours = len(lire_historique(chemin_historique))
    print(f"[HISTORIQUE] {nb_jours} jour(s) au total dans : {chemin_historique}")


if __name__ == "__main__":
    main()