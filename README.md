# Presenze TEKNOEDIL

Web app interna (PWA) per registrare le presenze degli operai: giornata con tutti presenti di default, assenze per causale anche a ore, straordinari, calendario mensile, riepilogo, export Excel per il consulente paghe, chiusura del mese, registro delle modifiche e backup.

- Interfaccia: HTML/CSS/JS senza framework, cartella `web/`, pubblicata su GitHub Pages dal workflow `.github/workflows/pages.yml`.
- Dati: Firebase (piano Spark), Authentication con Google e Firestore (europe-west8). Accesso consentito solo agli utenti elencati nell'app dall'amministratore.
- Regole di sicurezza: `firestore.rules` (l'email dell'amministratore iniziale è inserita solo nella console Firebase).

**In questo repository non ci sono dati personali**: anagrafica, presenze e utenti stanno solo nel database.

Strumento interno: non sostituisce il Libro Unico del Lavoro né il gestionale del consulente paghe.
