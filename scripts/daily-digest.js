// Imports
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');
const sgMail = require('@sendgrid/mail');

// Environment variables
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SENDGRID_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing required environment variables');
}

// Initialize clients
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
sgMail.setApiKey(SENDGRID_API_KEY);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const BATCH_SIZE = 5;
  const DELAY_BETWEEN_BATCHES = 2000;
  const DELAY_BETWEEN_EMAILS = 600;

  console.log("✨ Starting daily-digest batch processing");

  // Logique de date intelligente (6h limite)
  const nowParis = DateTime.now().setZone("Europe/Paris");
  let targetDate;

  if (nowParis.hour < 6) {
    // Déclenché entre 00h-06h → événements du jour même
    targetDate = nowParis.toISODate();
    console.log(`🕐 Déclenché avant 6h (${nowParis.hour}h) → événements du ${targetDate}`);
  } else {
    // Déclenché après 06h → événements du lendemain
    targetDate = nowParis.plus({ days: 1 }).toISODate();
    console.log(`🕐 Déclenché après 6h (${nowParis.hour}h) → événements du ${targetDate}`);
  }

  // Fetch data from Supabase
  const [sportsRes, eventsRes, broadcastersRes, teamsRes, alertsRes, usersRes] = await Promise.all([
    supabase.from("sports").select("id, name, emoji"),
    supabase.from("events").select("*").eq("status", "forecasted").eq("date", targetDate).order("time", { ascending: true }),
    supabase.from("broadcasters").select("*"),
    supabase.from("teams").select("id, name"),
    supabase.from("alerts").select("id, user_id, sport_id, league_id, team_id").eq("type", "email"),
    supabase.from("users").select("id, email")
  ]);

  if (eventsRes.error) throw new Error(`Error fetching events: ${eventsRes.error.message}`);
  if (!eventsRes.data?.length) {
    console.log("No events found for target date");
    return;
  }

  console.log(`📅 Found ${eventsRes.data.length} events for ${targetDate}`);

  // Create lookup maps
  const sportsMap = Object.fromEntries((sportsRes.data || []).map((s) => [s.id, s]));
  const teamsMap = Object.fromEntries((teamsRes.data || []).map((t) => [t.id, t.name.toLowerCase()]));
  const userIdToEmail = Object.fromEntries((usersRes.data || []).map((u) => [u.id, u.email]));
  const broadcasterMap = Object.fromEntries((broadcastersRes.data || []).map((b) => [b.id, b]));

  // Process events
  const events = eventsRes.data || [];
  events.forEach((e) => {
    e.broadcasters = (e.broadcaster_ids || []).map((id) => broadcasterMap[id]).filter(Boolean);
  });

  // Match users to events
  const userEventsMap = new Map();
  for (const event of events) {
    const isTennis = event.sport_id === 20;
    for (const alert of alertsRes.data || []) {
      if (alert.sport_id !== event.sport_id) continue;
      
      const match = isTennis 
        ? !alert.league_id || alert.league_id === (event.competition === "ATP Tour" ? 1 : event.competition === "WTA Tour" ? 22 : null)
        : !alert.team_id || [event.event_detail_1, event.event_detail_2].map((x) => x?.toLowerCase()).includes(teamsMap[alert.team_id]);
      
      if (match) {
        if (!userEventsMap.has(alert.user_id)) userEventsMap.set(alert.user_id, new Set());
        userEventsMap.get(alert.user_id).add(event);
      }
    }
  }

  const usersList = Array.from(userEventsMap.entries());
  console.log(`👥 Preparing digest for ${usersList.length} users`);

  let sent = 0, failed = 0;
  
  // Send emails in batches
  for (let i = 0; i < usersList.length; i += BATCH_SIZE) {
    const batch = usersList.slice(i, i + BATCH_SIZE);
    
    for (const [userId, eventsSet] of batch) {
      const email = userIdToEmail[userId];
      if (!email || !eventsSet.size) continue;

      const sorted = [...eventsSet].sort((a, b) => (a.start_at || '').localeCompare(b.start_at || ''));
      const html = generateEmailHTML(sorted, sportsMap);

      try {
        await sgMail.send({
          from: "Alert365 <no-reply@alert365.fr>",
          to: email,
          subject: "Alert365 : ton programme pour demain",
          html: html
        });
        
        console.log(`✅ Sent to ${email}`);
        sent++;
      } catch (error) {
        console.error(`❌ ${email}:`, error);
        failed++;
      }
      
      await sleep(DELAY_BETWEEN_EMAILS);
    }
    
    if (i + BATCH_SIZE < usersList.length) await sleep(DELAY_BETWEEN_BATCHES);
  }

  console.log(`📊 DONE: ${sent} sent, ${failed} failed`);
}

function generateEmailHTML(events, sportsMap) {
  const eventsHTML = events.map((event) => generateEventHTML(event, sportsMap)).join('');
  
  return `
    <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
    <html xmlns="http://www.w3.org/1999/xhtml" lang="fr">
    <head>
      <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Alert365 : ton programme de demain !</title>
      <style type="text/css">
        @media only screen and (max-width: 600px) {
          .mobile-center { text-align: center !important; }
          .mobile-full { width: 100% !important; }
          .mobile-padding { padding: 15px !important; }
        }
        .btn-round { border-radius: 20px; }
      </style>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: Arial, sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f3f4f6; padding: 20px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; max-width: 600px; width: 100%;" class="mobile-full">
              <tr>
                <td style="background-color: #0f172a; padding: 40px 30px; text-align: center;" class="mobile-padding">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="color: #ffffff; font-size: 32px; font-weight: bold; margin: 0; padding: 0; font-family: Arial, sans-serif;">
                        Alert<span style="color: #93C5FD;">365</span>
                      </td>
                    </tr>
                    <tr>
                      <td style="color: #ffffff; font-size: 16px; padding-top: 8px; opacity: 0.9; font-family: Arial, sans-serif;">
                        Ne manque plus jamais tes matchs préférés
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding: 30px;" class="mobile-padding">
                  ${eventsHTML}
                  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="padding-top: 25px;">
                    <tr>
                      <td style="text-align: center; color: #6b7280; font-size: 12px; line-height: 1.6; font-family: Arial, sans-serif;">
                        Tu reçois cet e-mail car tu as configuré une alerte sur Alert365<br>
                        <a href="https://alert365.fr" style="color: #0f172a; text-decoration: none;">Gérer mes alertes</a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

function generateEventHTML(event, sportsMap) {
  const sport = sportsMap[event.sport_id] || { name: 'Sport', emoji: '🏆' };
  const tv = event.broadcasters?.filter((b) => b.type === 'tv').sort((a, b) => a.name.localeCompare(b.name)) || [];
  const streaming = event.broadcasters?.filter((b) => b.type === 'streaming').sort((a, b) => a.name.localeCompare(b.name)) || [];

  const formatDate = (dateStr) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('fr-FR', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  const formatTime = (timeStr) => {
    return timeStr?.substring(0, 5) || '';
  };

  const renderBroadcasterRow = (broadcaster, type) => {
    const bgColor = type === 'streaming' ? '#00cec9' : '#ffeaa7';
    const textColor = type === 'streaming' ? '#ffffff' : '#1f2937';
    return `
      <tr>
        <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="color: #1f2937; font-size: 16px; font-family: Arial, sans-serif;" width="70%">
                ${broadcaster.name}
              </td>
              <td style="text-align: right;" width="30%">
                <a href="${broadcaster.url}" style="display: inline-block; padding: 4px 12px; background-color: ${bgColor}; color: ${textColor}; text-decoration: none; font-weight: bold; font-size: 14px; font-family: Arial, sans-serif; border-radius: 20px;">
                  Voir
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    `;
  };

  return `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 15px;">
      <tr>
        <td style="background-color: #0f172a; color: white; padding: 12px 20px; font-size: 16px; font-weight: bold; font-family: Arial, sans-serif; border-radius: 6px;">
          ${sport.emoji} ${sport.name} - ${event.competition || 'Compétition'} - ${formatTime(event.time)}
        </td>
      </tr>
    </table>

    <div style="margin-bottom: 40px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f8fafc; margin-bottom: 25px;">
        <tr>
          <td style="padding: 25px;" class="mobile-padding">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-size: 18px; font-weight: bold; color: #1f2937; padding-bottom: 15px; font-family: Arial, sans-serif;">
                  Détails de l'événement
                </td>
              </tr>
              <tr>
                <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="color: #6b7280; font-size: 16px; font-family: Arial, sans-serif;" width="30%">Sport</td>
                      <td style="color: #1f2937; font-weight: bold; font-size: 16px; text-align: right; font-family: Arial, sans-serif;" width="70%">${sport.name}</td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="color: #6b7280; font-size: 16px; font-family: Arial, sans-serif;" width="30%">Compétition</td>
                      <td style="color: #1f2937; font-weight: bold; font-size: 16px; text-align: right; font-family: Arial, sans-serif;" width="70%">${event.competition || 'N/A'}</td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="color: #6b7280; font-size: 16px; font-family: Arial, sans-serif;" width="30%">Événement</td>
                      <td style="color: #1f2937; font-weight: bold; font-size: 16px; text-align: right; font-family: Arial, sans-serif;" width="70%">${event.event_detail_1}${event.event_detail_2 ? ` - ${event.event_detail_2}` : ''}</td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="color: #6b7280; font-size: 16px; font-family: Arial, sans-serif;" width="30%">Date</td>
                      <td style="color: #1f2937; font-weight: bold; font-size: 16px; text-align: right; font-family: Arial, sans-serif;" width="70%">${formatDate(event.date)}</td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding: 12px 0;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="color: #6b7280; font-size: 16px; font-family: Arial, sans-serif;" width="30%">Heure</td>
                      <td style="text-align: right;" width="70%">
                        <span style="background-color: #0f172a; color: #ffffff; padding: 6px 12px; font-weight: bold; font-size: 14px; display: inline-block; font-family: Arial, sans-serif;" class="btn-round">
                          ${formatTime(event.time)}
                        </span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
      
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f8fafc;">
        <tr>
          <td style="padding: 25px;" class="mobile-padding">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-size: 18px; font-weight: bold; color: #1f2937; padding-bottom: 25px; font-family: Arial, sans-serif;">
                  Diffuseurs
                </td>
              </tr>
              
              ${tv.length > 0 ? `
              <tr>
                <td style="font-size: 14px; font-weight: 600; color: #374151; padding-bottom: 12px; padding-top: 4px; font-family: Arial, sans-serif; text-transform: uppercase; letter-spacing: 0.5px;">
                  <span style="color: #ffeaa7; font-size: 12px; margin-right: 6px;">▶</span> TV
                </td>
              </tr>
              ${tv.map((broadcaster) => renderBroadcasterRow(broadcaster, 'tv')).join('')}
              ` : ''}
              
              ${streaming.length > 0 ? `
              <tr>
                <td style="font-size: 14px; font-weight: 600; color: #374151; padding-bottom: 12px; padding-top: ${tv.length > 0 ? '25px' : '4px'}; font-family: Arial, sans-serif; text-transform: uppercase; letter-spacing: 0.5px;">
                  <span style="color: #10b981; font-size: 12px; margin-right: 6px;">▶</span> STREAMING
                </td>
              </tr>
              ${streaming.map((broadcaster) => renderBroadcasterRow(broadcaster, 'streaming')).join('')}
              ` : ''}
              
              ${tv.length === 0 && streaming.length === 0 ? `
              <tr>
                <td style="color: #6b7280; font-size: 14px; padding: 4px 0; font-family: Arial, sans-serif;">
                  Aucun diffuseur disponible
                </td>
              </tr>
              ` : ''}
            </table>
          </td>
        </tr>
      </table>
    </div>
  `;
}

// Run the main function
main().catch(console.error);
