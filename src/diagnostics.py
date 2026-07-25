"""
Moteur de calcul du bilan matiere, avec diagnostics de fiabilite sur
les variables racines (debit TH20, debit DO12, niveau silo).

Reproduit fidelement la logique de la feuille 'Analyses BC' du classeur
d'origine, formules verifiees cellule par cellule :
  H9  = IF(AND(B9>10, D9>5), 1, 0)              -> marche_alim
  Y9  = IF(AND(AA9>0.01, B9>10), B9/60, "")      -> Prod_vers_Sol
  Z9  = IF(AND(H9=0, X9>0.01), W9/60, 0)         -> Rejets_Vers_Sol
  J1  = I1 * (1 - I2)                            -> prod_sec
  Q5  = SUM(N9:N1448)/60                         -> Conso_farine
  R4  = (niveau_fin - niveau_debut) * 12         -> Delta_Silo_homo
  T3  = prod_sec - Conso_farine*0.9 - Delta_Silo_homo - Prod_vers_Sol - Rejets_Vers_Sol
"""

import statistics
import yaml


def charger_config(chemin_coefficients, chemin_recette):
    with open(chemin_coefficients, "r", encoding="utf-8") as f:
        coeffs = yaml.safe_load(f)
    with open(chemin_recette, "r", encoding="utf-8") as f:
        recette = yaml.safe_load(f)
    return coeffs, recette


def calculer_humidite_ponderee(recette_bc):
    """Humidite du melange = somme(composition% * H2O%) / 100."""
    total = sum(
        c["composition_pct"] * c["h2o_pct"] for c in recette_bc.values()
    )
    return total / 100.0 / 100.0  # une division /100 pour chaque %


def _valeurs_valides(liste):
    """Filtre les None/'' d'une colonne (minutes d'arret sans donnee)."""
    return [v for v in liste if isinstance(v, (int, float))]


def diagnostiquer_capteur_niveau(niveaux, seuil_ecart_type, seuil_pct_fige_max=70.0):
    """
    Variable racine la plus fragile du bilan : le capteur de niveau silo.
    Renvoie un diagnostic explicite plutot que de laisser le calcul
    silencieusement traiter un capteur fige comme un vrai '0'.

    IMPORTANT : l'ecart-type seul ne suffit pas. Un capteur fige 85% de la
    journee mais qui bouge normalement sur une courte fenetre (ex 02h-06h)
    peut avoir un ecart-type global superieur au seuil, alors que les DEUX
    points utilises par le calcul (premiere et derniere minute) tombent
    justement dans la zone figee. D'ou le double critere ci-dessous.
    """
    valides = _valeurs_valides(niveaux)
    n_total = len(niveaux)
    n_valides = len(valides)

    if n_valides < 2:
        return {
            "fiable": False,
            "raison": "moins de 2 valeurs numeriques sur la journee",
            "ecart_type": None,
            "pct_minutes_figees": None,
        }

    ecart_type = statistics.pstdev(valides)

    # compte les minutes ou la valeur est identique a la precedente
    minutes_figees = sum(
        1 for i in range(1, len(valides)) if valides[i] == valides[i - 1]
    )
    pct_minutes_figees = round(100 * minutes_figees / max(1, n_valides - 1), 1)

    # Critere 1 : suffisamment de mouvement sur l'ensemble de la journee
    bouge_assez = ecart_type >= seuil_ecart_type
    # Critere 2 : pas fige la majorite du temps (sinon debut/fin risquent
    # tous les deux de tomber dans une zone plate, meme si une fenetre
    # ailleurs dans la journee a bouge)
    pas_majoritairement_fige = pct_minutes_figees <= seuil_pct_fige_max

    fiable = bouge_assez and pas_majoritairement_fige

    if fiable:
        raison = None
    elif not bouge_assez:
        raison = f"ecart-type {ecart_type:.3f} < seuil {seuil_ecart_type}"
    else:
        raison = f"{pct_minutes_figees}% des minutes figees > seuil {seuil_pct_fige_max}%"

    return {
        "fiable": fiable,
        "raison": raison,
        "ecart_type": round(ecart_type, 3),
        "pct_minutes_figees": pct_minutes_figees,
        "niveau_debut": valides[0],
        "niveau_fin": valides[-1],
        "n_minutes_avec_donnee": n_valides,
        "n_minutes_total": n_total,
    }


def diagnostiquer_debit_th20(debit_th20, pw_moteur, seuil_debit_marche, seuil_pw_marche_bc, plafond_tph):
    """
    Diagnostic du debit TH20 (216 TH 20) - bascule d'entree du broyeur.
    Deux anomalies distinctes recherchees ici, differentes de celles du
    capteur de niveau : pas un capteur fige, mais un capteur qui peut
    soit manquer de donnees pendant la marche, soit compter de la matiere
    "fantome" pendant les arrets (matiere encore sur la bande convoyeuse).
    """
    n = len(debit_th20)
    valides = _valeurs_valides(debit_th20)

    # 1. Minutes manquantes PENDANT que le broyeur tourne (Pw > seuil).
    #    Une cellule vide est normale a l'arret ; elle ne devrait jamais
    #    arriver quand le moteur tourne.
    minutes_vides_en_marche = 0
    for i in range(n):
        d = debit_th20[i] if i < len(debit_th20) else None
        pw = pw_moteur[i] if i < len(pw_moteur) else None
        if d is None and isinstance(pw, (int, float)) and pw > seuil_pw_marche_bc:
            minutes_vides_en_marche += 1

    # 2. Tonnage "fantome" : debit non nul alors que le moteur est
    #    en dessous du seuil de marche (matiere sur bande, pas broyee).
    tonnage_fantome = 0.0
    minutes_fantome = 0
    for i in range(n):
        d = debit_th20[i] if i < len(debit_th20) else None
        pw = pw_moteur[i] if i < len(pw_moteur) else None
        if (isinstance(d, (int, float)) and d > seuil_debit_marche
                and isinstance(pw, (int, float)) and pw <= seuil_pw_marche_bc):
            tonnage_fantome += d / 60.0
            minutes_fantome += 1

    # 3. Valeurs physiquement impossibles (negatives ou au-dessus du plafond).
    aberrantes = [v for v in valides if v < 0 or v > plafond_tph]

    return {
        "minutes_vides_en_marche": minutes_vides_en_marche,
        "tonnage_fantome_t": round(tonnage_fantome, 1),
        "minutes_fantome": minutes_fantome,
        "n_valeurs_aberrantes": len(aberrantes),
        "valeurs_aberrantes_exemples": aberrantes[:5],
        # "fiable" = pas de donnee manquante ni de valeur impossible.
        # Le tonnage fantome peut etre non nul meme si fiable=True : c'est
        # une anomalie de PROCEDE (matiere sur bande), pas de CAPTEUR.
        # A surveiller separement, pas un critere de fiabilite du capteur.
        "fiable": minutes_vides_en_marche == 0 and len(aberrantes) == 0,
    }


def diagnostiquer_debit_do12(debit_dos_farine, position_volet, plafond_tph):
    """
    Diagnostic du debit DO12 (312 DO 12) - doseur four.
    Cherche du bruit capteur (debit non nul alors que le volet est ferme,
    donc la matiere ne devrait pas passer) et des trous de donnees pendant
    que le volet est ouvert (la ou on compte vraiment la consommation).
    """
    n = len(debit_dos_farine)
    valides = _valeurs_valides(debit_dos_farine)

    # 1. Bruit : volet ferme mais debit non nul quand meme.
    #    Sans consequence sur le calcul actuel (deja filtre par N9=IF(O9=0,"",M9))
    #    mais un signal utile sur l'etat du capteur.
    minutes_bruit_volet_ferme = 0
    tonnage_bruit = 0.0
    for i in range(n):
        pos = position_volet[i] if i < len(position_volet) else None
        d = debit_dos_farine[i] if i < len(debit_dos_farine) else None
        if pos in (None, 0) and isinstance(d, (int, float)) and d > 0.01:
            minutes_bruit_volet_ferme += 1
            tonnage_bruit += d / 60.0

    # 2. Trous de donnees PENDANT que le volet est ouvert (la ou ca compte).
    minutes_vides_volet_ouvert = 0
    for i in range(n):
        pos = position_volet[i] if i < len(position_volet) else None
        d = debit_dos_farine[i] if i < len(debit_dos_farine) else None
        if pos not in (None, 0) and d is None:
            minutes_vides_volet_ouvert += 1

    # 3. Valeurs physiquement impossibles.
    aberrantes = [v for v in valides if v < 0 or v > plafond_tph]

    return {
        "minutes_bruit_volet_ferme": minutes_bruit_volet_ferme,
        "tonnage_bruit_t": round(tonnage_bruit, 1),
        "minutes_vides_volet_ouvert": minutes_vides_volet_ouvert,
        "n_valeurs_aberrantes": len(aberrantes),
        "valeurs_aberrantes_exemples": aberrantes[:5],
        # "fiable" = pas de donnee manquante ni de valeur impossible.
        # Le bruit volet-ferme n'affecte deja PAS le calcul du bilan (le
        # filtre N9=IF(O9=0,"",M9) l'exclut), mais un bruit important est
        # un signe que le capteur merite d'etre inspecte physiquement.
        "fiable": minutes_vides_volet_ouvert == 0 and len(aberrantes) == 0,
    }


def calculer_bilan(donnees_tis, coeffs, recette_bc1):
    """Calcule le bilan matiere complet + diagnostics, pour la journee BC1."""

    debit_th20 = donnees_tis["debit_th20"]
    pw_moteur = donnees_tis["pw_moteur"]
    debit_dos_farine = donnees_tis["debit_dos_farine"]
    position_volet = donnees_tis["position_volet_alim_four"]
    debit_rejet = donnees_tis["debit_rejet"]
    rejet_vers_sol_flag = donnees_tis["rejet_vers_sol"]
    alim_vers_sol_flag = donnees_tis["alim_vers_sol"]
    niveau_silo = donnees_tis["niveau_silo"]

    n = len(debit_th20)

    seuil_debit = coeffs["seuil_debit_marche_alim_tph"]
    seuil_pw = coeffs["seuil_puissance_marche_alim_kw"]

    # ---- Production humide (I1) ----
    prod_wet = sum(_valeurs_valides(debit_th20)) / 60.0

    # ---- Humidite ponderee (I2) et production seche (J1) ----
    humidite = calculer_humidite_ponderee(recette_bc1)
    prod_sec = prod_wet * (1 - humidite)

    # ---- Consommation four (Q5) : debit dosage farine, uniquement volet ouvert ----
    conso_valeurs = []
    for i in range(n):
        pos = position_volet[i] if i < len(position_volet) else None
        deb = debit_dos_farine[i] if i < len(debit_dos_farine) else None
        if pos not in (None, 0) and isinstance(deb, (int, float)):
            conso_valeurs.append(deb)
    conso_farine = sum(conso_valeurs) / 60.0

    # ---- Marche alim (H) minute par minute, pour Rejets_vers_Sol ----
    marche_alim = []
    for i in range(n):
        b = debit_th20[i] if i < len(debit_th20) else None
        d = pw_moteur[i] if i < len(pw_moteur) else None
        etat = bool(isinstance(b, (int, float)) and isinstance(d, (int, float))
                    and b > seuil_debit and d > seuil_pw)
        marche_alim.append(etat)

    # ---- Production vers sol (Y8) : alim_vers_sol ouvert ET debit > 10 ----
    prod_vers_sol = 0.0
    for i in range(n):
        flag = alim_vers_sol_flag[i] if i < len(alim_vers_sol_flag) else None
        b = debit_th20[i] if i < len(debit_th20) else None
        if isinstance(flag, (int, float)) and flag > 0.01 and isinstance(b, (int, float)) and b > 10:
            prod_vers_sol += b / 60.0

    # ---- Rejets vers sol (Z8) : alim ARRETEE ET vanne rejet ouverte ----
    rejets_vers_sol = 0.0
    for i in range(n):
        flag = rejet_vers_sol_flag[i] if i < len(rejet_vers_sol_flag) else None
        w = debit_rejet[i] if i < len(debit_rejet) else None
        if (not marche_alim[i]) and isinstance(flag, (int, float)) and flag > 0.01 and isinstance(w, (int, float)):
            rejets_vers_sol += w / 60.0

    # ---- Diagnostic capteur niveau silo (variable racine la plus fragile) ----
    diag_niveau = diagnostiquer_capteur_niveau(
        niveau_silo,
        coeffs["seuil_ecart_type_capteur_fige_pct"],
        coeffs.get("seuil_pct_minutes_figees_max", 70.0),
    )

    # ---- Diagnostics debit TH20 et DO12 (les deux autres variables racines) ----
    diag_th20 = diagnostiquer_debit_th20(
        debit_th20, pw_moteur,
        seuil_debit, coeffs["seuil_puissance_marche_bc_kw"],
        coeffs.get("plafond_debit_th20_tph", 250),
    )
    diag_do12 = diagnostiquer_debit_do12(
        debit_dos_farine, position_volet,
        coeffs.get("plafond_debit_do12_tph", 250),
    )

    capacite_silo = coeffs["capacite_silo_tonnes"]
    if diag_niveau["fiable"]:
        delta_pct = diag_niveau["niveau_fin"] - diag_niveau["niveau_debut"]
        delta_silo = delta_pct * capacite_silo / 100.0
        delta_silo_statut = "mesure"
    else:
        delta_silo = 0.0
        delta_silo_statut = "INDETERMINE (capteur fige ou insuffisant) -> traite comme 0 par defaut"

    # ---- Residu T3 et T2 ----
    correction = coeffs["correction_doseur_four"]
    conso_corrigee = conso_farine * correction
    t3 = prod_sec - conso_corrigee - delta_silo - prod_vers_sol - rejets_vers_sol
    t2_pct = 100 * t3 / prod_sec if prod_sec else None

    return {
        "prod_wet_t": round(prod_wet, 1),
        "humidite_pct": round(humidite * 100, 2),
        "prod_sec_t": round(prod_sec, 1),
        "conso_farine_brute_t": round(conso_farine, 1),
        "correction_doseur_four": correction,
        "conso_farine_corrigee_t": round(conso_corrigee, 1),
        "delta_silo_t": round(delta_silo, 1),
        "delta_silo_statut": delta_silo_statut,
        "diagnostic_capteur_niveau": diag_niveau,
        "diagnostic_debit_th20": diag_th20,
        "diagnostic_debit_do12": diag_do12,
        "prod_vers_sol_t": round(prod_vers_sol, 1),
        "rejets_vers_sol_t": round(rejets_vers_sol, 1),
        "residu_T3_t": round(t3, 1),
        "residu_T2_pct": round(t2_pct, 2) if t2_pct is not None else None,
    }
