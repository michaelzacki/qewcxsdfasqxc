import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';

const redis = Redis.fromEnv();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.query.secret !== process.env.API_SECRET_KEY) {
    return res.status(401).send("Unauthorized");
  }

  try {
    console.log("Starting migration...");
    
    // Migrate Seasons
    const currentSeasonStr = await redis.get('season:current');
    let currentSeason = null;
    if (currentSeasonStr) {
      currentSeason = typeof currentSeasonStr === 'string' ? JSON.parse(currentSeasonStr) : currentSeasonStr;
      
      const { error: seasonErr } = await supabase.from('seasons').upsert({
        season_id: currentSeason.season_id,
        start_time: new Date(currentSeason.start_date || currentSeason.start_time || Date.now()).getTime(),
        end_time: new Date(currentSeason.end_date || currentSeason.end_time || (Date.now() + 30*24*60*60*1000)).getTime(),
        status: currentSeason.status || 'active'
      });
      if (seasonErr) console.error("Season migration error:", seasonErr);
    }

    // Migrate Players (globals_hash)
    const globals = await redis.hgetall('globals_hash') || {};
    const playerRows = [];
    
    for (const key in globals) {
      const steam_id = key.replace('steam:', '');
      let p = globals[key];
      if (typeof p === 'string') {
        try { p = JSON.parse(p); } catch (e) { continue; }
      }
      
      playerRows.push({
        steam_id,
        name: p.name || 'Unknown',
        kills: p.kills || 0,
        deaths: p.deaths || 0,
        assists: p.assists || 0,
        damage_dealt: p.damage_dealt || 0,
        damage_taken: p.damage_taken || 0,
        phantom_hits: p.phantom_hits || 0,
        mmr: p.mmr || 1000,
        rank: p.rank || 'Sentinel',
        sessions: p.sessions || 0,
        level: p.level || 1,
        is_mod_user: p.is_mod_user || false,
        weapons: p.weapons || null,
        armors: p.armors || null,
        talismans: p.talismans || null,
        stats: p.stats || null,
        damage_breakdown: p.damage_breakdown || null,
        last_request_time: p.last_request_time || 0,
        permanent_rewards: p.permanent_rewards || [],
        pending_items: p.pending_items || [],
        gank_slayer_progress: p.gank_slayer_progress || 0
      });
    }

    // Batch insert players 50 at a time
    for (let i = 0; i < playerRows.length; i += 50) {
      const batch = playerRows.slice(i, i + 50);
      const { error: pErr } = await supabase.from('players').upsert(batch, { onConflict: 'steam_id' });
      if (pErr) console.error(`Player migration error (batch ${i}):`, pErr);
    }

    // Migrate Bounties
    const bounties = await redis.hgetall('bounties:active') || {};
    for (const id in bounties) {
      let b = bounties[id];
      if (typeof b === 'string') {
         try { b = JSON.parse(b); } catch(e) { continue; }
      }
      const { error: bErr } = await supabase.from('bounties').upsert({
        bounty_id: id,
        host_name: b.host_name,
        description: b.description || '',
        mmr_reward: b.mmr_reward || 300,
        created_at: b.created_at || Date.now()
      });
      
      if (!bErr) {
        // Migrating bounty members is tricky because we only have a list of killed steam_ids
        // But we'll just insert the kills
        const kills = await redis.smembers(`bounty:${id}:kills`) || [];
        for (const killed_id of kills) {
           await supabase.from('bounty_members').upsert({
              bounty_id: id,
              steam_id: killed_id,
              name: 'Unknown',
              is_killed: true
           });
        }
      }
    }

    return res.status(200).json({ success: true, migrated_players: playerRows.length });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
