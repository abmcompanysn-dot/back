/**
 * MIAD Market — Journal des Interventions Techniques
 * Google Apps Script — à coller dans https://script.google.com
 *
 * INSTALLATION :
 * 1. Aller sur https://script.google.com → Nouveau projet
 * 2. Coller tout ce fichier dans l'éditeur
 * 3. Cliquer "Déployer" → "Nouveau déploiement" → Type : Application Web
 *    - Exécuter en tant que : Moi
 *    - Accès : Tout le monde
 * 4. Copier l'URL de déploiement → la coller dans index.html (APPS_SCRIPT_URL)
 */

// ── Configuration ───────────────────────────────────────────────────────────
const EMAIL_DESTINATAIRES = [
  'abmcompanysn@gmail.com',
  'kanteibrahima91@gmail.com',
];
const EMAIL_URGENCE = [
  'batekossi@gmail.com',
];
const NOM_FEUILLE    = 'Journal Interventions MIAD';
const MOT_DE_PASSE   = 'Jesus1234@';   // technicien
const ADMIN_PASSWORD = 'MiadAdmin2026!'; // admin — changer si besoin
// ────────────────────────────────────────────────────────────────────────────

function getOuCreerFeuille() {
  const fichiers = DriveApp.getFilesByName(NOM_FEUILLE);
  let spreadsheet;
  if (fichiers.hasNext()) {
    spreadsheet = SpreadsheetApp.openById(fichiers.next().getId());
  } else {
    spreadsheet = SpreadsheetApp.create(NOM_FEUILLE);
    const sheet = spreadsheet.getActiveSheet();
    sheet.setName('Interventions');
    const entetes = [
      'Date','Heure','Technicien','Type','Composant',
      'Description','Erreurs détectées','Modifications apportées',
      'Statut','Durée (min)','Notes','ID'
    ];
    sheet.appendRow(entetes);
    const r = sheet.getRange(1, 1, 1, entetes.length);
    r.setBackground('#c0392b');
    r.setFontColor('#ffffff');
    r.setFontWeight('bold');
    r.setFontSize(11);
    [100,80,150,160,160,280,280,280,110,100,240,130].forEach((w,i) => sheet.setColumnWidth(i+1, w));
    sheet.setFrozenRows(1);
  }
  return spreadsheet;
}

// ── POST — soumettre une intervention ───────────────────────────────────────
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    if (data.password !== MOT_DE_PASSE && data.password !== ADMIN_PASSWORD) {
      return json({ success: false, error: 'Mot de passe incorrect.' });
    }

    const id = 'INT-' + new Date().getTime();
    const now = new Date();
    const dateStr  = Utilities.formatDate(now, 'Europe/Paris', 'dd/MM/yyyy');
    const heureStr = Utilities.formatDate(now, 'Europe/Paris', 'HH:mm');

    const spreadsheet = getOuCreerFeuille();
    const sheet = spreadsheet.getSheetByName('Interventions') || spreadsheet.getActiveSheet();
    const ligne = [
      dateStr, heureStr,
      data.technicien||'', data.type||'', data.composant||'',
      data.description||'', data.erreurs||'', data.modifications||'',
      data.statut||'', data.duree||'', data.notes||'', id,
    ];
    sheet.appendRow(ligne);
    const couleur = data.statut === 'Résolu' ? '#d5f5e3'
                  : data.statut === 'En cours' ? '#fef9e7' : '#fce4e4';
    sheet.getRange(sheet.getLastRow(), 1, 1, ligne.length).setBackground(couleur);

    envoyerEmail(data, id, dateStr, heureStr, spreadsheet.getUrl());
    return json({ success: true, id });

  } catch (err) {
    return json({ success: false, error: err.toString() });
  }
}

// ── GET — dashboard admin : liste toutes les interventions ──────────────────
function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};

  // Vérification de connexion : le client envoie le mot de passe saisi et ne
  // reçoit en retour que le rôle/nom associé — jamais les mots de passe
  // eux-mêmes, qui restent uniquement ici côté serveur.
  if (params.action === 'login') {
    if (params.password === ADMIN_PASSWORD) {
      return json({ success: true, role: 'admin', name: 'Admin principal' });
    }
    if (params.password === MOT_DE_PASSE) {
      return json({ success: true, role: 'technicien', name: 'Technicien' });
    }
    return json({ success: false });
  }

  // Test de disponibilité
  if (!params.password) {
    return json({ status: 'MIAD Tech Log API — OK' });
  }

  if (params.password !== ADMIN_PASSWORD) {
    return json({ success: false, error: 'Accès non autorisé.' });
  }

  try {
    const spreadsheet = getOuCreerFeuille();
    const sheet = spreadsheet.getSheetByName('Interventions') || spreadsheet.getActiveSheet();
    const rows  = sheet.getDataRange().getValues();
    const headers = rows[0];
    const interventions = rows.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    }).reverse(); // plus récent en premier

    return json({ success: true, interventions, sheetUrl: spreadsheet.getUrl() });
  } catch (err) {
    return json({ success: false, error: err.toString() });
  }
}

function json(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Email ────────────────────────────────────────────────────────────────────
function envoyerEmail(data, id, dateStr, heureStr, sheetUrl) {
  const estEscalade = data.statut === 'Escaladé';
  const estResolu   = data.statut === 'Résolu';
  const statutEmoji = estResolu ? '✅' : estEscalade ? '🚨' : '⚠️';
  const couleur     = estResolu ? '#1e8449' : estEscalade ? '#c0392b' : '#e67e22';
  const sujet = `${estEscalade ? '🚨 URGENT — ' : ''}[MIAD Market Diagnostic] ${statutEmoji} ${data.type} · ${data.composant} (${id})`;
  const nl = s => (s || '').replace(/\n/g, '<br>');

  const corps = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,sans-serif;color:#222;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
<tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="background:#1a1a2e;border-radius:10px 10px 0 0;padding:18px 28px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><img src="https://www.miadmarket.com/logo/logo.png" alt="MIAD" height="34" style="display:block;"></td>
      <td align="right" style="color:rgba(255,255,255,.6);font-size:11px;text-transform:uppercase;letter-spacing:1px;">Diagnostic Technique</td>
    </tr></table>
  </td></tr>
  ${estEscalade ? `<tr><td style="background:#7b241c;color:#fff;text-align:center;padding:10px;font-weight:bold;font-size:13px;letter-spacing:1px;">🚨 INTERVENTION ESCALADÉE — ACTION REQUISE</td></tr>` : ''}
  <tr><td style="background:${couleur};padding:16px 28px;">
    <div style="color:#fff;font-size:17px;font-weight:bold;">🔧 ${data.type||'—'}</div>
    <div style="color:rgba(255,255,255,.85);font-size:13px;margin-top:3px;">${data.composant||'—'}</div>
  </td></tr>
  <tr><td style="background:#fff;padding:24px 28px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 10px 10px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;margin-bottom:18px;">
      <tr><td style="padding:8px 10px;background:#fafafa;color:#888;width:130px;border-bottom:1px solid #eee;">ID</td>
          <td style="padding:8px 10px;background:#fafafa;font-family:monospace;font-weight:bold;border-bottom:1px solid #eee;">${id}</td>
          <td style="padding:8px 10px;color:#888;width:100px;border-bottom:1px solid #eee;">Date</td>
          <td style="padding:8px 10px;border-bottom:1px solid #eee;">${dateStr} ${heureStr}</td></tr>
      <tr><td style="padding:8px 10px;color:#888;border-bottom:1px solid #eee;">Technicien</td>
          <td style="padding:8px 10px;font-weight:700;border-bottom:1px solid #eee;">${data.technicien||'—'}</td>
          <td style="padding:8px 10px;color:#888;border-bottom:1px solid #eee;">Durée</td>
          <td style="padding:8px 10px;border-bottom:1px solid #eee;">${data.duree ? data.duree+' min' : '—'}</td></tr>
      <tr><td style="padding:8px 10px;background:#fafafa;color:#888;">Statut</td>
          <td colspan="3" style="padding:8px 10px;background:#fafafa;">
            <span style="background:${couleur};color:#fff;padding:3px 14px;border-radius:12px;font-size:12px;font-weight:bold;">${statutEmoji} ${data.statut||'—'}</span>
          </td></tr>
    </table>
    <div style="margin-bottom:12px;padding:14px;background:#f8f9fa;border-radius:8px;border-left:4px solid #555;">
      <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:bold;">📋 Description</div>
      <div style="font-size:13px;line-height:1.6;">${nl(data.description)||'—'}</div>
    </div>
    ${data.erreurs ? `<div style="margin-bottom:12px;padding:14px;background:#fdf2f2;border-radius:8px;border-left:4px solid #e74c3c;">
      <div style="font-size:11px;color:#c0392b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:bold;">🔴 Erreurs détectées</div>
      <div style="font-size:13px;line-height:1.6;">${nl(data.erreurs)}</div></div>` : ''}
    ${data.modifications ? `<div style="margin-bottom:12px;padding:14px;background:#f2fdf5;border-radius:8px;border-left:4px solid #27ae60;">
      <div style="font-size:11px;color:#1e8449;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:bold;">🔧 Modifications apportées</div>
      <div style="font-size:13px;line-height:1.6;">${nl(data.modifications)}</div></div>` : ''}
    ${data.notes ? `<div style="margin-bottom:12px;padding:14px;background:#fffde7;border-radius:8px;border-left:4px solid #f39c12;">
      <div style="font-size:11px;color:#b7950b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:bold;">📌 Notes</div>
      <div style="font-size:13px;line-height:1.6;">${nl(data.notes)}</div></div>` : ''}
    <div style="text-align:center;margin-top:20px;">
      <a href="${sheetUrl}" style="background:${couleur};color:#fff;padding:11px 28px;border-radius:7px;text-decoration:none;font-weight:bold;font-size:13px;">📊 Consulter le journal →</a>
    </div>
    <div style="margin-top:18px;padding-top:12px;border-top:1px solid #eee;text-align:center;font-size:11px;color:#bbb;">
      MIAD Market — Base de connaissances technique · ${dateStr} ${heureStr}
    </div>
  </td></tr>
</table></td></tr></table>
</body></html>`;

  const tous = estEscalade
    ? [...new Set([...EMAIL_DESTINATAIRES, ...EMAIL_URGENCE])]
    : EMAIL_DESTINATAIRES;
  tous.forEach(email => MailApp.sendEmail({ to: email, subject: sujet, htmlBody: corps }));
}
