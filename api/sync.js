import { Redis } from '@upstash/redis';
import crypto from 'crypto';
import JSONBig from 'json-bigint';

const redis = Redis.fromEnv();
const JSONBigString = JSONBig({ storeAsString: true });

const CURRENT_SERVER_VERSION = "1.0.4";

const SECRET_API_KEY = process.env.API_SECRET_KEY;
const HMAC_SECRET = process.env.HMAC_SECRET_KEY;

export const config = {
  api: {
    bodyParser: false,
  },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function verifySignature(playerId, data, modVersion, clientSig) {
  if (!HMAC_SECRET || !clientSig) return false;
  const canonical = [
    playerId,
    data.name || '',
    data.kills || 0,
    data.deaths || 0,
    data.assists || 0,
    data.damage_dealt || 0,
    data.damage_taken || 0,
    data.mmr || 0,
    modVersion
  ].join('|');

  const serverSig = crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(canonical)
    .digest('hex');

  return serverSig === clientSig;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    // Parse URL for query params
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const action = url.searchParams.get('action');

    if (action === 'season') {
      try {
        let raw = await redis.get('season:current');
        console.log('[SEASON] Raw from Redis:', typeof raw, JSON.stringify(raw));

        let currentSeason = null;
        if (!raw) {
          // Initialize season 1 if it doesn't exist
          const now = new Date();
          const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
          currentSeason = {
            season_id: 1,
            start_date: now.toISOString(),
            end_date: endDate.toISOString(),
            status: "active"
          };
          await redis.set('season:current', JSON.stringify(currentSeason));
        } else if (typeof raw === 'string') {
          try { currentSeason = JSON.parse(raw); } catch (e) { currentSeason = null; }
        } else if (typeof raw === 'object') {
          currentSeason = raw;
        }

        if (!currentSeason || !currentSeason.season_id) {
          console.log('[SEASON] Failed to parse season data, raw:', raw);
          return res.status(500).json({ error: 'Season data corrupted', raw_type: typeof raw, raw: String(raw).substring(0, 200) });
        }

        const seasonId = currentSeason.season_id;

        // Fetch top 10 leaderboard
        let leaderboard = [];
        try {
          const top10 = await redis.zrange(`season:${seasonId}:leaderboard`, 0, 9, { rev: true, withScores: true });
          if (top10 && Array.isArray(top10)) {
            for (let i = 0; i < top10.length; i += 2) {
              let sId = String(top10[i]);
              if (sId.startsWith("steam:")) sId = sId.replace("steam:", "");
              leaderboard.push({
                steam_id: sId,
                mmr: parseInt(top10[i + 1]) || 0,
                placement: (i / 2) + 1
              });
            }
          }
        } catch (e) {
          console.error('[SEASON] Leaderboard fetch error:', e);
        }

        // Optionally fetch rewards for the requesting player if steam_id is provided
        const steamId = url.searchParams.get('steam_id');
        let my_rewards = [];
        let permanent_rewards = [];
        let pending_items = [];
        if (steamId) {
          const rewardStr = await redis.hget(`season:${seasonId}:rewards`, steamId);
          if (rewardStr) {
            try { my_rewards.push(JSON.parse(rewardStr)); } catch (e) { }
          }

          const globalStr = await redis.hget('globals_hash', `steam:${steamId}`);
          if (globalStr) {
            try {
              let globalData = typeof globalStr === 'string' ? JSON.parse(globalStr) : globalStr;
              if (globalData.permanent_rewards) permanent_rewards = globalData.permanent_rewards;
              if (globalData.pending_items) pending_items = globalData.pending_items;
            } catch (e) { }
          }
        }

        return res.status(200).json({
          season: currentSeason,
          leaderboard: leaderboard,
          my_rewards: my_rewards,
          permanent_rewards: permanent_rewards,
          pending_items: pending_items
        });
      } catch (error) {
        console.error('[SEASON] Top-level error:', error);
        return res.status(500).json({ error: 'Season read error', details: error.message });
      }
    }

    if (action === 'past_season') {
      const season_id = req.query.season_id;
      if (!season_id) return res.status(400).json({ error: 'season_id required' });
      try {
        const snapshot = await redis.hgetall(`season:${season_id}:snapshot`) || {};
        for (let key in snapshot) {
          if (typeof snapshot[key] === 'string') {
            try { snapshot[key] = JSON.parse(snapshot[key]); } catch (e) { }
          }
        }
        return res.status(200).json(snapshot);
      } catch (error) {
        return res.status(500).json({ error: 'Read error' });
      }
    }

    try {
      const globals = await redis.hgetall('globals_hash') || {};

      for (let key in globals) {
        if (typeof globals[key] === 'string') {
          try {
            globals[key] = JSON.parse(globals[key]);
          } catch (e) { }
        }
      }
      return res.status(200).json(globals);
    } catch (error) {
      return res.status(500).json({ error: 'Read error' });
    }
  }

  if (req.method === 'POST') {
    const clientApiKey = req.headers['x-api-key'];

    if (!clientApiKey || clientApiKey.trim() !== SECRET_API_KEY) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: '31' });
    }

    const action = req.query.action;
    if (action === 'end_season') {
      try {
        const globals = await redis.hgetall('globals_hash') || {};
        const currentSeasonStr = await redis.get('season:current');
        let currentSeason = currentSeasonStr;
        if (typeof currentSeasonStr === 'string') currentSeason = JSON.parse(currentSeasonStr);
        if (!currentSeason) return res.status(400).json({ error: 'No active season' });

        const seasonId = currentSeason.season_id;

        // 1. Snapshot globals_hash to season:{id}:snapshot
        const snapshot = {};
        for (let key in globals) {
          let val = globals[key];
          if (typeof val === 'object' && val !== null) {
            snapshot[key] = JSON.stringify(val);
          } else {
            snapshot[key] = val;
          }
        }
        if (Object.keys(snapshot).length > 0) {
          await redis.hset(`season:${seasonId}:snapshot`, snapshot);
        }

        // --- REWARD DISTRIBUTION ---
        // Fetch top 3 players from leaderboard
        const topPlayers = await redis.zrange(`season:${seasonId}:leaderboard`, 0, 2, { rev: true });
        const rewardMap = {};
        if (topPlayers && topPlayers.length > 0) {
          for (let i = 0; i < topPlayers.length; i++) {
            rewardMap[topPlayers[i]] = i + 1; // 1, 2, 3
          }
        }

        // 2. Reset competitive stats and apply rewards in globals_hash
        for (let key in globals) {
          let pStr = globals[key];
          let p = null;
          try {
            if (typeof pStr === 'string') {
              p = JSON.parse(pStr);
            } else if (typeof pStr === 'object' && pStr !== null) {
              p = pStr;
            }
          } catch (e) { }
          if (p) {
            // Apply rewards if they are in top 3
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
                rewardObj.badgeIcon = "symbol_crown.png";
                p.pending_items.push({ id: 1075744784, qty: 599 }); // Marika's Rune
              } else if (placement === 2) {
                rewardObj.title = `S${seasonId} Top 2`;
                p.pending_items.push({ id: 1075744784, qty: 300 }); // Marika's Rune
              } else if (placement === 3) {
                rewardObj.title = `S${seasonId} Top 3`;
                p.pending_items.push({ id: 1075744784, qty: 100 }); // Marika's Rune
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
            await redis.hset('globals_hash', { [key]: JSON.stringify(p) });
          }
        }

        // 3. Advance season
        currentSeason.season_id += 1;
        currentSeason.start_time = Date.now();
        currentSeason.end_time = currentSeason.start_time + (30 * 24 * 60 * 60 * 1000);
        await redis.set('season:current', JSON.stringify(currentSeason));

        return res.status(200).json({ success: true, message: `Season ${seasonId} ended, season ${currentSeason.season_id} started.` });
      } catch (e) {
        return res.status(500).json({ error: 'Error ending season' });
      }
    }

    let body;
    try {
      const rawBody = await getRawBody(req);
      body = JSONBigString.parse(rawBody);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const { player_id: raw_player_id, data, mod_version, signature, season_id } = body;
    const player_id = String(raw_player_id);

    if (!player_id) return res.status(400).json({ error: 'player_id needed' });

    if (!mod_version || mod_version !== CURRENT_SERVER_VERSION) {
      return res.status(403).json({
        error: 'OUTDATED_CLIENT',
        message: `Force update required.`
      });
    }

    // HMAC-SHA256 Anti-Tamper Verification
    if (!verifySignature(player_id, data, mod_version, signature)) {
      return res.status(403).json({ error: 'INVALID_SIGNATURE', message: 'Tampered data rejected.' });
    }

    console.log(`[1] after sign: [SYNC INCOMING] Player: ${data.name} | SteamID: ${player_id} | MMR: ${data.mmr}`);

    try {
      let pStr = await redis.hget('globals_hash', `steam:${player_id}`);
      let p = null;
      if (typeof pStr === 'string') {
        try { p = JSON.parse(pStr); } catch (e) { }
      } else {
        p = pStr;
      }

      if (!p || typeof p !== 'object') {
        p = {
          kills: 0, deaths: 0, assists: 0, damage_dealt: 0, damage_taken: 0, sessions: 0,
          phantom_hits: 0, name: data.name || "Unknown", mmr: 1000, rank: "Sentinel",
          last_request_time: 0
        };
      }

      const now = Date.now();

      if (p.last_request_time && (now - p.last_request_time < 1500)) {
        return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many requests.' });
      }
      p.last_request_time = now;

      console.log(`[2] after p.last_request_time [SYNC INCOMING] Player: ${data.name} | SteamID: ${player_id} | MMR: ${data.mmr}`);

      // SEASON BOUNDARY CHECK
      let currentSeasonStr = await redis.get('season:current');
      let currentSeason = currentSeasonStr ? (typeof currentSeasonStr === 'string' ? JSON.parse(currentSeasonStr) : currentSeasonStr) : null;
      let isOldSeason = false;

      if (currentSeason && season_id !== undefined && parseInt(season_id) !== currentSeason.season_id) {
         console.log(`[FAILSAFE] Player ${player_id} uploaded stats for OLD season ${season_id}. Server is on ${currentSeason.season_id}. Discarding KDA & MMR.`);
         isOldSeason = true;
      }

      if (!isOldSeason) {
        p.kills = (p.kills || 0) + (data.kills || 0);
        p.deaths = (p.deaths || 0) + (data.deaths || 0);
        p.assists = (p.assists || 0) + (data.assists || 0);
        p.damage_dealt = (p.damage_dealt || 0) + (data.damage_dealt || 0);
        p.damage_taken = (p.damage_taken || 0) + (data.damage_taken || 0);
        p.phantom_hits = (p.phantom_hits || 0) + (data.phantom_hits || 0);

        p.damage_breakdown = p.damage_breakdown || { physical: 0, magic: 0, fire: 0, lightning: 0, holy: 0 };
        if (data.damage_breakdown) {
          p.damage_breakdown.physical += (data.damage_breakdown.physical || 0);
          p.damage_breakdown.magic += (data.damage_breakdown.magic || 0);
          p.damage_breakdown.fire += (data.damage_breakdown.fire || 0);
          p.damage_breakdown.lightning += (data.damage_breakdown.lightning || 0);
          p.damage_breakdown.holy += (data.damage_breakdown.holy || 0);
        }

        if (data.mmr !== undefined) {
          if (data.mmr === 1000 && p.mmr > 1050) {
            console.log(`[FAILSAFE] MMR Override Prevented for ${player_id}. Server: ${p.mmr}, Client sent: ${data.mmr}`);
            // Do not change p.mmr or p.rank
          } else if (p.mmr !== undefined && Math.abs(data.mmr - p.mmr) > 2000) {
            console.log(`[FAILSAFE] Massive MMR jump prevented for ${player_id}. Server: ${p.mmr}, Client sent: ${data.mmr}`);
            // Do not change p.mmr or p.rank
          } else {
            p.mmr = data.mmr;
            p.rank = data.rank ?? p.rank;
          }
        }
      }

      if (data.is_session_end) p.sessions += 1;

      if (data.clear_pending_items) {
        p.pending_items = [];
      }

      p.name = data.name ?? p.name;
      p.level = data.level ?? p.level;
      p.is_mod_user = data.is_mod_user ?? p.is_mod_user;

      // --- YENİ: Sezon Leaderboard Güncellemesi ---
      try {
        let currentSeasonStr = await redis.get('season:current');
        if (currentSeasonStr) {
          let currentSeason = typeof currentSeasonStr === 'string' ? JSON.parse(currentSeasonStr) : currentSeasonStr;
          let seasonId = currentSeason.season_id;
          if (p.mmr !== undefined && p.mmr !== null) {
            await redis.zadd(`season:${seasonId}:leaderboard`, { score: p.mmr, member: `steam:${player_id}` });
          }
        }
      } catch (e) {
        console.error("Failed to update season leaderboard", e);
      }
      // --------------------------------------------

      p.weapons = data.weapons ?? p.weapons;
      p.armors = data.armors ?? p.armors;
      p.talismans = data.talismans ?? p.talismans;
      p.stats = data.stats ?? p.stats;

      await redis.hset('globals_hash', { [`steam:${player_id}`]: JSON.stringify(p) });
      return res.status(200).json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: 'Write error' });
    }
  }
}
