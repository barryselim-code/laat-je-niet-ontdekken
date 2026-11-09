// Edge Function 'push': verstuurt Web Push-meldingen voor Betrapt! (W4/W5).
// Wordt alleen aangeroepen door de database (geheim.push) met de header x-push-geheim.
// De sleutels staan in geheim.config en worden gelezen via public.push_config() (alleen service-rol).
// Deploy zonder JWT-controle (de functie controleert zelf het gedeelde geheim).
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
let cfg: Record<string, string> | null = null;

async function config() {
  if (cfg) return cfg;
  const { data, error } = await sb.rpc('push_config');
  if (error) throw error;
  cfg = data as Record<string, string>;
  webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);
  return cfg;
}

Deno.serve(async (req) => {
  let c;
  try { c = await config(); } catch (e) { return Response.json({ fout: String(e?.message ?? e) }, { status: 500 }); }
  if (req.method !== 'POST' || !c.push_geheim || req.headers.get('x-push-geheim') !== c.push_geheim) {
    return new Response('nee', { status: 401 });
  }
  const { ontvangers, bericht } = await req.json();
  if (!Array.isArray(ontvangers) || !ontvangers.length) return Response.json({ verstuurd: 0 });
  const { data, error } = await sb.from('push_abonnementen').select('endpoint, p256dh, auth').in('speler_id', ontvangers);
  if (error) return Response.json({ fout: error.message }, { status: 500 });
  let verstuurd = 0;
  await Promise.all((data ?? []).map(async (a) => {
    try {
      await webpush.sendNotification({ endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } },
        JSON.stringify(bericht), { TTL: 60, urgency: 'high' });
      verstuurd++;
    } catch (e) {
      // verlopen abonnement opruimen
      if (e?.statusCode === 404 || e?.statusCode === 410) await sb.from('push_abonnementen').delete().eq('endpoint', a.endpoint);
    }
  }));
  return Response.json({ verstuurd });
});
