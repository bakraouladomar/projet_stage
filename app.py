"""
Interface web locale du suivi broyeur cru.

Lancement :  streamlit run app.py

Ne contient AUCUNE logique de calcul - uniquement de l'affichage. Tout le
calcul est delegue a src/lecture_tis.py, src/diagnostics.py et
src/historique.py, exactement comme main.py (la version terminal).
"""

import os
import sys

import pandas as pd
import streamlit as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

from lecture_tis import lire_export_tis
from diagnostics import charger_config, calculer_bilan
from historique import enregistrer_resultat, lire_historique


BASE_DIR = os.path.dirname(__file__)
CHEMIN_COEFFS = os.path.join(BASE_DIR, "config", "coefficients.yaml")
CHEMIN_RECETTE = os.path.join(BASE_DIR, "config", "recette_labo.yaml")
CHEMIN_HISTORIQUE = os.path.join(BASE_DIR, "historique_silo_farine.csv")

COULEUR_OK = "#2F7D5C"
COULEUR_ALERTE = "#B23A2E"

st.set_page_config(
    page_title="Suivi Broyeur Cru — Tétouan",
    page_icon="⚙️",
    layout="wide",
)

# --------------------------------------------------------------------------
# Styles - voyants d'alarme façon armoire électrique pour les diagnostics,
# chiffres cles en police monospace pour evoquer un afficheur d'instrument.
# --------------------------------------------------------------------------
st.markdown(
    """
    <style>
    .bloc-metrique {
        background: #FFFFFF;
        border-radius: 4px;
        padding: 18px 20px;
        border: 1px solid #E2E4E1;
    }
    .bloc-metrique .valeur {
        font-family: 'Courier New', monospace;
        font-size: 2.1rem;
        font-weight: 700;
        color: #1D2126;
    }
    .bloc-metrique .label {
        font-size: 0.78rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #6B6F73;
        margin-bottom: 4px;
    }
    .voyant {
        border-radius: 4px;
        padding: 14px 16px;
        background: #FFFFFF;
        border: 1px solid #E2E4E1;
        border-left: 6px solid var(--c);
    }
    .voyant .titre {
        font-weight: 700;
        font-size: 0.95rem;
        color: #1D2126;
    }
    .voyant .etat {
        font-family: 'Courier New', monospace;
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0.05em;
        color: var(--c);
        margin: 3px 0 6px 0;
    }
    .voyant .detail {
        font-size: 0.8rem;
        color: #5B5F63;
    }
    </style>
    """,
    unsafe_allow_html=True,
)


def voyant(colonne, titre, fiable, detail):
    couleur = COULEUR_OK if fiable else COULEUR_ALERTE
    etat = "FIABLE" if fiable else "A VERIFIER"
    colonne.markdown(
        f"""
        <div class="voyant" style="--c:{couleur}">
            <div class="titre">{titre}</div>
            <div class="etat">● {etat}</div>
            <div class="detail">{detail}</div>
        </div>
        """,
        unsafe_allow_html=True,
    )


def metrique(colonne, label, valeur):
    colonne.markdown(
        f"""
        <div class="bloc-metrique">
            <div class="label">{label}</div>
            <div class="valeur">{valeur}</div>
        </div>
        """,
        unsafe_allow_html=True,
    )


# --------------------------------------------------------------------------
# Barre laterale : depot du fichier du jour
# --------------------------------------------------------------------------
with st.sidebar:
    st.markdown("## Atelier broyage cru")
    st.caption("Suivi silo farine — Tétouan")
    st.divider()
    fichier = st.file_uploader("Export TIS du jour (.xlsx)", type=["xlsx"])
    st.divider()
    n_jours_historique = len(lire_historique(CHEMIN_HISTORIQUE))
    st.caption(f"{n_jours_historique} jour(s) dans l'historique")

st.title("Bilan matière — broyeur cru BC1")

# --------------------------------------------------------------------------
# Traitement du fichier depose
# --------------------------------------------------------------------------
if fichier is None:
    st.info("Déposez l'export TIS du jour dans le panneau de gauche pour lancer le calcul.")
else:
    try:
        with st.spinner("Lecture de l'export et calcul du bilan..."):
            donnees = lire_export_tis(fichier)
            coeffs, recette = charger_config(CHEMIN_COEFFS, CHEMIN_RECETTE)
            resultat = calculer_bilan(donnees, coeffs, recette["BC1"])
            date_str = str(donnees.get("_date_journee") or "date inconnue")
            deja_present = enregistrer_resultat(CHEMIN_HISTORIQUE, date_str, resultat)
    except ValueError as e:
        st.error(f"Erreur de lecture : {e}")
        st.stop()

    st.subheader(f"Journée du {date_str}")
    if deja_present:
        st.caption("Ce jour existait déjà dans l'historique — ligne mise à jour.")

    c1, c2, c3, c4 = st.columns(4)
    metrique(c1, "Production sèche", f"{resultat['prod_sec_t']:.1f} t")
    metrique(c2, "Conso. four (corrigée)", f"{resultat['conso_farine_corrigee_t']:.1f} t")
    metrique(c3, "Résidu T3", f"{resultat['residu_T3_t']:.1f} t")
    metrique(c4, "Résidu T2", f"{resultat['residu_T2_pct']:.2f} %")

    st.markdown("#### Diagnostics des capteurs (variables racines)")
    d1, d2, d3 = st.columns(3)

    diag_niv = resultat["diagnostic_capteur_niveau"]
    detail_niv = diag_niv["raison"] or f"{diag_niv['pct_minutes_figees']}% du temps figé"
    voyant(d1, "Niveau silo", diag_niv["fiable"], detail_niv)

    diag_th20 = resultat["diagnostic_debit_th20"]
    voyant(d2, "Débit TH20 (entrée)", diag_th20["fiable"],
           f"{diag_th20['tonnage_fantome_t']} t fantôme sur {diag_th20['minutes_fantome']} min")

    diag_do12 = resultat["diagnostic_debit_do12"]
    voyant(d3, "Débit DO12 (four)", diag_do12["fiable"],
           f"{diag_do12['tonnage_bruit_t']} t de bruit sur {diag_do12['minutes_bruit_volet_ferme']} min")

    with st.expander("Détail complet du bilan"):
        detail_df = pd.DataFrame(
            [
                ("Production humide", f"{resultat['prod_wet_t']} t"),
                ("Humidité mélange", f"{resultat['humidite_pct']} %"),
                ("Production sèche", f"{resultat['prod_sec_t']} t"),
                ("Conso. four (brute)", f"{resultat['conso_farine_brute_t']} t"),
                (f"Conso. four (× {resultat['correction_doseur_four']})", f"{resultat['conso_farine_corrigee_t']} t"),
                ("Delta silo", f"{resultat['delta_silo_t']} t — {resultat['delta_silo_statut']}"),
                ("Production vers sol", f"{resultat['prod_vers_sol_t']} t"),
                ("Rejets vers sol", f"{resultat['rejets_vers_sol_t']} t"),
            ],
            columns=["Terme", "Valeur"],
        )
        st.table(detail_df.set_index("Terme"))

st.divider()

# --------------------------------------------------------------------------
# Historique : evolution du residu dans le temps
# --------------------------------------------------------------------------
st.subheader("Historique")
lignes = lire_historique(CHEMIN_HISTORIQUE)

if not lignes:
    st.caption("Aucun jour traité pour l'instant. Déposez des exports TIS pour construire l'historique.")
else:
    df = pd.DataFrame(lignes)
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["residu_T2_pct"] = pd.to_numeric(df["residu_T2_pct"], errors="coerce")
    df["capteur_niveau_pct_fige"] = pd.to_numeric(df["capteur_niveau_pct_fige"], errors="coerce")
    df = df.sort_values("date")

    g1, g2 = st.columns(2)
    with g1:
        st.caption("Résidu T2 (%) — écart du bilan, jour par jour")
        st.line_chart(df.set_index("date")["residu_T2_pct"])
    with g2:
        st.caption("Capteur niveau silo — % de minutes figées, jour par jour")
        st.line_chart(df.set_index("date")["capteur_niveau_pct_fige"])

    st.caption("Détail jour par jour")
    st.dataframe(df, use_container_width=True, hide_index=True)