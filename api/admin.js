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
      const { data } = payload;
      if (!data) return res.status(400).json({ error: 'Missing data' });
      await redis.set('season:current', JSON.stringify(data));
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}
