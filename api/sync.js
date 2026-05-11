import { Redis } from '@upstash/redis';
const redis = Redis.fromEnv();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const globals = await redis.get('globals') || {};
      return res.status(200).json(globals);
    } catch (error) {
      return res.status(500).json({ error: 'Read error' });
    }
  }

  if (req.method === 'POST') {
    const { player_id, data } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id needed' });

    try {
      let globals = await redis.get('globals') || {};
      
      if (!globals[player_id]) {
        globals[player_id] = {
          kills: 0, deaths: 0, assists: 0, damage_dealt: 0, damage_taken: 0, sessions: 0,
          name: data.name || "Unknown", mmr: 1000, rank: "Unranked"
        };
      }

      let p = globals[player_id];

      p.kills += (data.kills || 0);
      p.deaths += (data.deaths || 0);
      p.assists += (data.assists || 0);
      p.damage_dealt += (data.damage_dealt || 0);
      p.damage_taken += (data.damage_taken || 0);
      p.sessions += 1;

      p.name = data.name || p.name;
      p.mmr = data.mmr || p.mmr; 
      p.rank = data.rank || p.rank;
      p.level = data.level || p.level;
      p.is_mod_user = data.is_mod_user || p.is_mod_user;
      
      p.weapons = data.weapons || p.weapons;
      p.armors = data.armors || p.armors;
      p.talismans = data.talismans || p.talismans;

      globals[player_id] = p;
      await redis.set('globals', globals);
      
      return res.status(200).json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: 'Write error' });
    }
  }
}
