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
    if (action === 'get_config') {
      return res.status(200).json({ 
        supabase_url: process.env.SUPABASE_URL, 
        supabase_anon_key: process.env.SUPABASE_ANON_KEY 
      });
    }

    if (action === 'get_live_players') {
      const twoMinsAgo = Date.now() - (2 * 60 * 1000);
      const { data: players } = await supabase.from('players')
        .select('*')
        .gt('last_request_time', twoMinsAgo)
        .not('telemetry', 'is', null);
      return res.status(200).json(players || []);
    }

    if (action === 'get_killfeed') {
      const { data: kills } = await supabase.from('kill_feed').select('*').order('created_at', { ascending: false }).limit(50);
      return res.status(200).json(kills || []);
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

    if (action === 'get_past_seasons') {
      const { data: pastSeasons, error } = await supabase.from('past_seasons').select('*');
      if (error) console.error('[ADMIN] get_past_seasons error:', error);
      return res.status(200).json(pastSeasons || []);
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
      
      const insertData = {
          title: data.title,
          message: data.message,
          expires_at: Date.now() + (data.duration_seconds * 1000),
          sound: data.sound,
          target_steam_ids: data.target_steam_ids
      };
      
      await supabase.from('broadcasts').insert(insertData);
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

    // --- LICENSES ---
    if (action === 'get_licenses') {
      const { data: licenses, error } = await supabase.from('licenses').select('*');
      if (error) console.error('[ADMIN] get_licenses error:', error);
      return res.status(200).json(licenses || []);
    }
    if (action === 'delete_license') {
      const { key } = payload;
      if (!key) return res.status(400).json({ error: 'Missing key' });
      await supabase.from('licenses').delete().eq('key', key);
      return res.status(200).json({ success: true });
    }

    // --- BANS ---
    if (action === 'get_bans') {
      const { data: bans } = await supabase.from('bans').select('*').order('created_at', { ascending: false });
      return res.status(200).json(bans || []);
    }
    if (action === 'ban_player') {
      const { steam_id, reason, expires_at } = payload;
      if (!steam_id) return res.status(400).json({ error: 'Missing steam_id' });
      await supabase.from('bans').insert({ steam_id, reason: reason || 'Banned by admin', expires_at: expires_at || null });
      
      // Also kick the player immediately by modifying their memory/state if needed
      // (This can be handled via live broadcast or memory injection in C++)
      return res.status(200).json({ success: true });
    }
    if (action === 'unban_player') {
      const { steam_id } = payload;
      if (!steam_id) return res.status(400).json({ error: 'Missing steam_id' });
      await supabase.from('bans').delete().eq('steam_id', steam_id);
      return res.status(200).json({ success: true });
    }

    // --- BOUNTIES ---
    if (action === 'get_bounties') {
      const { data: bounties } = await supabase.from('bounties').select('*, bounty_members(*)').order('created_at', { ascending: false });
      return res.status(200).json(bounties || []);
    }
    if (action === 'create_bounty') {
      const { data } = payload;
      if (!data) return res.status(400).json({ error: 'Missing data' });
      await supabase.from('bounties').insert(data);
      return res.status(200).json({ success: true });
    }
    if (action === 'delete_bounty') {
      const { id } = payload;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      await supabase.from('bounties').delete().eq('bounty_id', id);
      return res.status(200).json({ success: true });
    }
    if (action === 'clear_bounties') {
      // Delete all past bounties
      await supabase.from('bounties').delete().neq('bounty_id', '0'); 
      return res.status(200).json({ success: true });
    }
    if (action === 'manual_bounty_kill') {
      const { bounty_id, killed_steam_id } = payload;
      if (!bounty_id || !killed_steam_id) return res.status(400).json({ error: 'Missing parameters' });
      await supabase.from('bounty_members').update({ is_killed: true }).eq('bounty_id', bounty_id).eq('steam_id', killed_steam_id);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Supabase error', details: err.message });
  }
}