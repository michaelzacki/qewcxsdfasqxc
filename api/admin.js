import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const adminSecret = req.headers['x-admin-secret'];
  if (!ADMIN_PASSWORD || adminSecret !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'UNAUTHORIZED: Invalid Admin Password' });
  }

  const { action, payload } = req.body;
  if (!action) return res.status(400).json({ error: 'No action provided' });

  try {
    if (action === 'get_live_players') {
      const { data: players } = await supabase.from('players').select('*').gt('last_request_time', Date.now() - 120000);
      return res.status(200).json(players || []);
    }

    if (action === 'get_players') {
      const { data: players } = await supabase.from('players').select('*');
      return res.status(200).json(players || []);
    }

    if (action === 'update_player') {
      const { steam_id, data } = payload;
      if (!steam_id || !data) return res.status(400).json({ error: 'Missing steam_id or data' });

      console.log(`[ADMIN] Updating player ${steam_id} with data:`, data);
      await supabase.from('players').update(data).eq('steam_id', steam_id);
      return res.status(200).json({ success: true });
    }

    if (action === 'delete_player') {
      const { steam_id } = payload;
      if (!steam_id) return res.status(400).json({ error: 'Missing steam_id' });
      await supabase.from('players').delete().eq('steam_id', steam_id);
      return res.status(200).json({ success: true });
    }

    if (action === 'get_season') {
      const { data: currentSeason } = await supabase.from('seasons').select('*').eq('status', 'active').order('season_id', { ascending: false }).limit(1).single();
      return res.status(200).json(currentSeason || null);
    }

    if (action === 'update_season') {
      const { data } = payload;
      if (!data) return res.status(400).json({ error: 'Missing data' });
      
      const { data: currentSeason } = await supabase.from('seasons').select('*').eq('status', 'active').order('season_id', { ascending: false }).limit(1).single();
      if (currentSeason) {
         await supabase.from('seasons').update(data).eq('season_id', currentSeason.season_id);
      }
      return res.status(200).json({ success: true });
    }

    if (action === 'restart_season') {
      const { data: currentSeason } = await supabase.from('seasons').select('*').eq('status', 'active').order('season_id', { ascending: false }).limit(1).single();
      if (currentSeason) {
        // Mark old season as inactive
        await supabase.from('seasons').update({ status: 'inactive' }).eq('season_id', currentSeason.season_id);
        
        // Start new season
        const nextId = currentSeason.season_id + 1;
        const now = Date.now();
        await supabase.from('seasons').insert({
           season_id: nextId,
           start_time: now,
           end_time: now + 30 * 24 * 60 * 60 * 1000,
           status: 'active'
        });
        
        // Reset player stats
        await supabase.from('players').update({
           kills: 0, deaths: 0, assists: 0, damage_dealt: 0, damage_taken: 0, phantom_hits: 0, mmr: 1000, rank: 'Sentinel',
           damage_breakdown: { physical: 0, magic: 0, fire: 0, lightning: 0, holy: 0 }
        }).neq('steam_id', '0'); // update all
      }
      return res.status(200).json({ success: true });
    }

    if (action === 'create_broadcast') {
      const { data } = payload;
      if (!data) return res.status(400).json({ error: 'Missing data' });
      await supabase.from('broadcasts').insert(data);
      return res.status(200).json({ success: true });
    }

    if (action === 'get_broadcast') {
      const { data: broadcast } = await supabase.from('broadcasts').select('*').gt('expires_at', Date.now()).limit(1).single();
      return res.status(200).json(broadcast || null);
    }

    if (action === 'clear_broadcast') {
      await supabase.from('broadcasts').delete().neq('id', '0'); // delete all
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Supabase error', details: err.message });
  }
}