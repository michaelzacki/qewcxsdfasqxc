import { Redis } from '@upstash/redis';
import JSONBig from 'json-bigint';

const redis = Redis.fromEnv();
const JSONBigString = JSONBig({ storeAsString: true });

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

export default async function handler(req, res) {
  // CORS Headers
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
    if (action === 'get_players') {
      const globals = await redis.hgetall('globals_hash') || {};
      const parsedPlayers = [];
      for (const key in globals) {
        try {
          const steam_id = key.replace('steam:', '');
          let playerData = globals[key];
          if (typeof playerData === 'string') playerData = JSON.parse(playerData);
          parsedPlayers.push({ steam_id, ...playerData });
        } catch (e) {}
      }
      return res.status(200).json(parsedPlayers);
    }

    if (action === 'update_player') {
      const { steam_id, data } = payload;
      if (!steam_id || !data) return res.status(400).json({ error: 'Missing steam_id or data' });
      
      console.log(`[ADMIN] Updating player ${steam_id} with data:`, data);
      
      const key = `steam:${steam_id}`;
      let existingStr = await redis.hget('globals_hash', key);
      let existingData = existingStr ? (typeof existingStr === 'string' ? JSON.parse(existingStr) : existingStr) : {};
      
      const updatedData = { ...existingData, ...data };
      await redis.hset('globals_hash', { [key]: JSON.stringify(updatedData) });
      
      // Update MMR in leaderboard if provided
      if (data.mmr !== undefined) {
         let currentSeasonStr = await redis.get('season:current');
         if (currentSeasonStr) {
             let currentSeason = typeof currentSeasonStr === 'string' ? JSON.parse(currentSeasonStr) : currentSeasonStr;
             await redis.zadd(`season:${currentSeason.season_id}:leaderboard`, { score: data.mmr, member: `steam:${steam_id}` });
         }
      }
      return res.status(200).json({ success: true });
    }

    if (action === 'delete_player') {
      const { steam_id } = payload;
      if (!steam_id) return res.status(400).json({ error: 'Missing steam_id' });
      await redis.hdel('globals_hash', `steam:${steam_id}`);
      
      let currentSeasonStr = await redis.get('season:current');
      if (currentSeasonStr) {
          let currentSeason = typeof currentSeasonStr === 'string' ? JSON.parse(currentSeasonStr) : currentSeasonStr;
          await redis.zrem(`season:${currentSeason.season_id}:leaderboard`, `steam:${steam_id}`);
      }
      return res.status(200).json({ success: true });
    }

    if (action === 'get_season') {
      let currentSeasonStr = await redis.get('season:current');
      if (!currentSeasonStr) return res.status(200).json(null);
      let currentSeason = typeof currentSeasonStr === 'string' ? JSON.parse(currentSeasonStr) : currentSeasonStr;
      return res.status(200).json(currentSeason);
    }

    if (action === 'update_season') {
      // Only update fields of the CURRENT season (does not create a new one)
      const { data } = payload;
      if (!data) return res.status(400).json({ error: 'Missing data' });
      
      let currentSeasonStr = await redis.get('season:current');
      let currentSeason = currentSeasonStr ? (typeof currentSeasonStr === 'string' ? JSON.parse(currentSeasonStr) : currentSeasonStr) : {};
      
      // Merge updates
      const updated = { ...currentSeason, ...data };
      await redis.set('season:current', JSON.stringify(updated));
      return res.status(200).json({ success: true, season: updated });
    }

    if (action === 'create_season') {
      // Create a brand new season. If there's a current one, archive it first.
      const { season_id, start_date, end_date, status } = payload;
      if (!season_id || !start_date || !end_date) {
        return res.status(400).json({ error: 'Missing season_id, start_date, or end_date' });
      }
      
      // Archive current season if exists
      let currentSeasonStr = await redis.get('season:current');
      if (currentSeasonStr) {
        let old = typeof currentSeasonStr === 'string' ? JSON.parse(currentSeasonStr) : currentSeasonStr;
        // Save old season metadata
        await redis.set(`season:${old.season_id}:meta`, JSON.stringify({ ...old, status: 'ended' }));
      }
      
      const newSeason = {
        season_id: parseInt(season_id),
        start_date: start_date,
        end_date: end_date,
        status: status || 'active'
      };
      
      await redis.set('season:current', JSON.stringify(newSeason));
      return res.status(200).json({ success: true, season: newSeason });
    }

    if (action === 'give_item') {
      const { steam_id, item } = payload;
      if (!steam_id || !item) return res.status(400).json({ error: 'Missing steam_id or item' });
      
      const key = `steam:${steam_id}`;
      let existingStr = await redis.hget('globals_hash', key);
      let existingData = existingStr ? (typeof existingStr === 'string' ? JSON.parse(existingStr) : existingStr) : {};
      
      if (!existingData.pending_items) existingData.pending_items = [];
      existingData.pending_items.push(item);
      
      await redis.hset('globals_hash', { [key]: JSON.stringify(existingData) });
      return res.status(200).json({ success: true, message: 'Item queued for delivery.' });
    }

    if (action === 'end_season') {
      // End the current season: snapshot globals_hash, archive season meta, assign rewards
      let currentSeasonStr = await redis.get('season:current');
      if (!currentSeasonStr) return res.status(400).json({ error: 'No active season to end' });
      
      let currentSeason = typeof currentSeasonStr === 'string' ? JSON.parse(currentSeasonStr) : currentSeasonStr;
      const seasonId = currentSeason.season_id;
      
      // 1. Snapshot globals_hash & Assign permanent rewards
      const globals = await redis.hgetall('globals_hash') || {};
      
      // Fetch top 3 to assign rewards
      let topPlayers = [];
      try {
        const top = await redis.zrevrange(`season:${seasonId}:leaderboard`, 0, 2, { withScores: true });
        if (top && Array.isArray(top)) {
            for (let i = 0; i < top.length; i += 2) {
                let sId = String(top[i]);
                if (sId.startsWith("steam:")) sId = sId.replace("steam:", "");
                topPlayers.push({ steam_id: sId, placement: (i/2) + 1, mmr: parseInt(top[i+1]) });
            }
        }
      } catch(e) { console.error(e); }

      // Assign rewards
      for (const player of topPlayers) {
          const key = `steam:${player.steam_id}`;
          let pData = globals[key];
          if (pData) {
              if (typeof pData === 'string') pData = JSON.parse(pData);
              if (!pData.permanent_rewards) pData.permanent_rewards = [];
              
              let border = "Gold";
              let badge = "symbol_crown.png";
              let color = "#ffd700";
              
              if (player.placement === 2) { border = "Silver"; badge = ""; color = "#c0c0c0"; }
              if (player.placement === 3) { border = "Bronze"; badge = ""; color = "#cd7f32"; }

              pData.permanent_rewards.push({
                  season_id: seasonId,
                  placement: player.placement,
                  border: border,
                  badge: badge,
                  color: color
              });
              
              // Give Item Pack
              if (!pData.pending_items) pData.pending_items = [];
              if (player.placement === 1) {
                  pData.pending_items.push({ id: 1100, qty: 99, reinforceLv: -1, upgrade: -1, gem: -1 }); // Example item pack
              } else if (player.placement <= 3) {
                  pData.pending_items.push({ id: 1100, qty: 50, reinforceLv: -1, upgrade: -1, gem: -1 });
              }

              globals[key] = JSON.stringify(pData);
              await redis.hset('globals_hash', { [key]: globals[key] });
          }
      }

      if (Object.keys(globals).length > 0) {
        await redis.hset(`season:${seasonId}:snapshot`, globals);
      }
      
      // 2. Archive season meta
      currentSeason.status = 'ended';
      currentSeason.ended_at = new Date().toISOString();
      await redis.set(`season:${seasonId}:meta`, JSON.stringify(currentSeason));
      
      // 3. Update current as ended
      await redis.set('season:current', JSON.stringify(currentSeason));
      
      return res.status(200).json({ success: true, message: `Season ${seasonId} ended, snapshot taken, and rewards assigned.` });
    }

    if (action === 'list_seasons') {
      // Scan for all season:X:meta keys
      let seasons = [];
      
      // Check current season
      let currentSeasonStr = await redis.get('season:current');
      if (currentSeasonStr) {
        let current = typeof currentSeasonStr === 'string' ? JSON.parse(currentSeasonStr) : currentSeasonStr;
        current._is_current = true;
        seasons.push(current);
      }
      
      // Check past seasons (scan up to 50)
      for (let i = 1; i <= 50; i++) {
        let metaStr = await redis.get(`season:${i}:meta`);
        if (metaStr) {
          let meta = typeof metaStr === 'string' ? JSON.parse(metaStr) : metaStr;
          // Don't duplicate if it's the same as current
          if (currentSeasonStr) {
            let current = typeof currentSeasonStr === 'string' ? JSON.parse(currentSeasonStr) : currentSeasonStr;
            if (current.season_id === meta.season_id) continue;
          }
          seasons.push(meta);
        }
      }
      
      return res.status(200).json(seasons);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}
