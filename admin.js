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
        } catch (e) { }
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
      let currentSeasonStr = await redis.get('season:current');
      if (!currentSeasonStr) return res.status(400).json({ error: 'No active season to end' });

      let currentSeason = typeof currentSeasonStr === 'string' ? JSON.parse(currentSeasonStr) : currentSeasonStr;
      const seasonId = currentSeason.season_id;

      const globals = await redis.hgetall('globals_hash') || {};

      // Fetch top 3 to assign rewards
      let topPlayers = [];
      try {
        const top = await redis.zrange(`season:${seasonId}:leaderboard`, 0, 2, { rev: true });
        console.log(`[ADMIN] end_season fetched top from leaderboard:`, top);
        if (top && Array.isArray(top)) {
          for (let i = 0; i < top.length; i++) {
            let sId = String(top[i]);
            if (sId.startsWith("steam:")) sId = sId.replace("steam:", "");
            topPlayers.push({ steam_id: sId, placement: i + 1 });
          }
        }
        console.log(`[ADMIN] topPlayers parsed:`, topPlayers);
      } catch (e) { console.error("Leaderboard fetch error:", e); }

      const rewardMap = {};
      for (const tp of topPlayers) {
        rewardMap[`steam:${tp.steam_id}`] = tp.placement;
      }
      console.log(`[ADMIN] rewardMap:`, rewardMap);

      for (let key in globals) {
        let pStr = globals[key];
        let p = null;
        try { p = JSON.parse(pStr); } catch (e) { }
        if (p) {
          if (rewardMap[key]) {
            const placement = rewardMap[key];
            if (!p.permanent_rewards) p.permanent_rewards = [];
            if (!p.pending_items) p.pending_items = [];

            let colorHex = "#738C8C"; // Wretch (0+)
            if (p.mmr >= 4000) colorHex = "#FF0D0D"; // Top Tier
            else if (p.mmr >= 3000) colorHex = "#FA0570"; // Veteran
            else if (p.mmr >= 2600) colorHex = "#E00D99"; // Maestro
            else if (p.mmr >= 2300) colorHex = "#C714CC"; // Pontiff Demon
            else if (p.mmr >= 2000) colorHex = "#A61AF2"; // Dreadnought
            else if (p.mmr >= 1800) colorHex = "#8026FA"; // Slaughter
            else if (p.mmr >= 1600) colorHex = "#5933FA"; // Sweatlord
            else if (p.mmr >= 1400) colorHex = "#3359F2"; // Meta Lord
            else if (p.mmr >= 1200) colorHex = "#4080D9"; // Butcher of PvErs
            else if (p.mmr >= 1000) colorHex = "#6699BF"; // Sentinel
            else if (p.mmr >= 800) colorHex = "#99A6B3"; // Underdog

            let rewardObj = { season_id: seasonId, placement: placement, color: colorHex };
            if (placement === 1) {
              rewardObj.title = `S${seasonId} Champion`;
              rewardObj.badgeIcon = "👑";
              p.pending_items.push({ id: 1075744784, qty: 600, reinforceLv: -1, upgrade: -1, gem: -1 });
            } else if (placement === 2) {
              rewardObj.title = `S${seasonId} Top 2`;
              p.pending_items.push({ id: 1075744784, qty: 300, reinforceLv: -1, upgrade: -1, gem: -1 });
            } else if (placement === 3) {
              rewardObj.title = `S${seasonId} Top 3`;
              p.pending_items.push({ id: 1075744784, qty: 150, reinforceLv: -1, upgrade: -1, gem: -1 });
            }
            p.permanent_rewards.push(rewardObj);
          }

          p.kills = 0;
          p.deaths = 0;
          p.assists = 0;
          p.damage_dealt = 0;
          p.damage_taken = 0;
          p.phantom_hits = 0;
          p.mmr = 1000;
          p.rank = "Sentinel";
          if (p.damage_breakdown) {
            p.damage_breakdown = { physical: 0, magic: 0, fire: 0, lightning: 0, holy: 0 };
          }
          globals[key] = JSON.stringify(p);
          await redis.hset('globals_hash', { [key]: globals[key] });
        }
      }

      if (Object.keys(globals).length > 0) {
        await redis.hset(`season:${seasonId}:snapshot`, globals);
      }

      currentSeason.status = 'ended';
      currentSeason.ended_at = new Date().toISOString();
      await redis.set(`season:${seasonId}:meta`, JSON.stringify(currentSeason));

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
