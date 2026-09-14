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

    // 4. Migrate Licenses
    const keys = await redis.keys('license:*');
    let licenseCount = 0;
    let licenseDebug = { keysFound: keys.length, firstKey: keys[0], firstValue: null, parseError: null };
    if (keys.length > 0) {
      const values = await redis.mget(...keys);
      licenseDebug.firstValue = values[0];
      const licenseRows = [];
      for (let i = 0; i < keys.length; i++) {
        const rawKeyStr = keys[i].replace('license:', '');
        let lStr = values[i];
        let l = null;
        if (lStr) {
           try { l = typeof lStr === 'string' ? JSON.parse(lStr) : lStr; } catch(e) { if(i===0) licenseDebug.parseError = e.message; }
        }
        if (l) {
          let expAt = null;
          if (l.expires_at) {
             try { expAt = new Date(l.expires_at).toISOString(); } catch(e) {}
          }
          licenseRows.push({
            key: rawKeyStr,
            duration_days: l.duration_days || 30,
            max_devices: l.max_devices || 1,
            max_accounts: l.max_accounts || 1,
            banned: l.banned || false,
            expires_at: expAt,
            devices: Array.isArray(l.devices) ? l.devices : [],
            accounts: Array.isArray(l.accounts) ? l.accounts : []
          });
        }
      }
      
      for (let i = 0; i < licenseRows.length; i += 50) {
        const batch = licenseRows.slice(i, i + 50);
        const { error: lErr } = await supabase.from('licenses').upsert(batch, { onConflict: 'key' });
        if (lErr) {
           console.error(`License migration error:`, lErr);
           licenseDebug.dbError = lErr.message;
        }
      }
      licenseCount = licenseRows.length;
    }

    // 5. Migrate Bans
    const bans = await redis.smembers('bans:global');
    let banCount = 0;
    if (bans && bans.length > 0) {
      const banRows = bans.map(b => {
        return {
          value: b,
          reason: 'Migrated from Redis',
          banned_at: new Date().toISOString()
        };
      });
      for (let i = 0; i < banRows.length; i += 50) {
        const batch = banRows.slice(i, i + 50);
        const { error: banErr } = await supabase.from('bans').upsert(batch, { onConflict: 'value' });
        if (banErr) console.error(`Ban migration error:`, banErr);
      }
      banCount = bans.length;
    }

    // 6. Migrate Broadcasts
    const broadcastStr = await redis.get('broadcast:current');
    let broadcastCount = 0;
    if (broadcastStr) {
      let b = null;
      try { b = typeof broadcastStr === 'string' ? JSON.parse(broadcastStr) : broadcastStr; } catch(e){}
      if (b) {
        const { error: bcErr } = await supabase.from('broadcasts').upsert({
          id: 1,
          message: b.message || '',
          url: b.url || '',
          color: b.color || '#ff0000',
          active: true,
          created_at: new Date().toISOString()
        });
        if (bcErr) console.error('Broadcast migration error:', bcErr);
        else broadcastCount = 1;
      }
    }

    // 7. Migrate Past Seasons (Snapshots)
    const pastSeasonKeys = await redis.keys('season:*:snapshot');
    let pastSeasonsCount = 0;
    if (pastSeasonKeys && pastSeasonKeys.length > 0) {
       for (const pKey of pastSeasonKeys) {
          const sIdMatch = pKey.match(/season:(\d+):snapshot/);
          if (sIdMatch) {
             const sId = parseInt(sIdMatch[1]);
             const snapshotRaw = await redis.hgetall(pKey);
             
             let snapshotParsed = {};
             if (snapshotRaw) {
                for (const k in snapshotRaw) {
                   try {
                      snapshotParsed[k] = typeof snapshotRaw[k] === 'string' ? JSON.parse(snapshotRaw[k]) : snapshotRaw[k];
                   } catch(e) {
                      snapshotParsed[k] = snapshotRaw[k];
                   }
                }
             }

             const { error: psErr } = await supabase.from('past_seasons').upsert({
                season_id: sId,
                leaderboard: snapshotParsed
             });
             if (psErr) console.error("Past season migration error:", psErr);
             else pastSeasonsCount++;
          }
       }
    }

    return res.status(200).json({ 
      success: true, 
      migrated_players: playerRows.length, 
      migrated_licenses: licenseCount,
      migrated_bans: banCount,
      migrated_broadcasts: broadcastCount,
      migrated_past_seasons: pastSeasonsCount,
      licenseDebug
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
