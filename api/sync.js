import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import JSONBig from 'json-bigint';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
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

// --- GLOBAL MEMORY CACHE ---
let cachedSeason = null;
let lastSeasonFetch = 0;

async function getCurrentSeasonCached() {
  const now = Date.now();
  if (cachedSeason && (now - lastSeasonFetch < 60000)) {
    return cachedSeason;
  }
  const { data, error } = await supabase.from('seasons').select('*').eq('status', 'active').order('season_id', { ascending: false }).limit(1).single();
  let currentSeason = null;
  if (!data || error) {
    const endDate = new Date(now + 30 * 24 * 60 * 60 * 1000);
    currentSeason = { season_id: 1, start_time: now, end_time: endDate.getTime(), status: "active" };
    await supabase.from('seasons').insert(currentSeason);
  } else {
    currentSeason = data;
  }
  cachedSeason = currentSeason;
  lastSeasonFetch = now;
  return currentSeason;
}
// ---------------------------

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
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=59');
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const action = url.searchParams.get('action');

    if (action === 'season') {
      try {
        let currentSeason = await getCurrentSeasonCached();
        const steamId = url.searchParams.get('steam_id');

        // Fetch top 10 leaderboard
        const { data: topPlayers, error: lbError } = await supabase
          .from('players')
          .select('steam_id, mmr, name')
          .order('mmr', { ascending: false })
          .limit(10);
          
        let leaderboard = [];
        if (topPlayers && !lbError) {
          leaderboard = topPlayers.map((p, index) => ({
             steam_id: p.steam_id,
             mmr: p.mmr || 0,
             placement: index + 1
          }));
        }

        let my_rewards = [];
        let permanent_rewards = [];
        let pending_items = [];
        
        if (steamId) {
          const { data: myData } = await supabase.from('players').select('permanent_rewards, pending_items').eq('steam_id', steamId).single();
          if (myData) {
            permanent_rewards = myData.permanent_rewards || [];
            pending_items = myData.pending_items || [];
          }
        }

        let returnSeason = { ...currentSeason };
        if (returnSeason.end_time) {
          returnSeason.end_date = new Date(returnSeason.end_time).toISOString();
        }

        return res.status(200).json({
          season: returnSeason,
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
      const seasonIdStr = url.searchParams.get('season_id');
      if (!seasonIdStr) return res.status(400).json({ error: 'season_id required' });
      const { data: pastData } = await supabase.from('past_seasons').select('leaderboard').eq('season_id', parseInt(seasonIdStr)).single();
      
      let returnObj = {};
      if (pastData && pastData.leaderboard) {
         returnObj = pastData.leaderboard;
      }
      return res.status(200).json(returnObj);
    }

    try {
      const { data: players, error } = await supabase.from('players').select('*');
      if (error) throw error;
      const globals = {};
      players.forEach(p => { globals[`steam:${p.steam_id}`] = p; });
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
      return res.status(410).json({ error: 'DISABLED', message: 'Season end rewards have been disabled.' });
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
      return res.status(403).json({ error: 'OUTDATED_CLIENT', message: `Force update required.` });
    }

    if (!verifySignature(player_id, data, mod_version, signature)) {
      return res.status(403).json({ error: 'INVALID_SIGNATURE', message: 'Tampered data rejected.' });
    }

    try {
      // 1. Fetch current player data
      const { data: pData } = await supabase.from('players').select('*').eq('steam_id', player_id).single();
      let p = pData || {
        steam_id: player_id, kills: 0, deaths: 0, assists: 0, damage_dealt: 0, damage_taken: 0, sessions: 0,
        phantom_hits: 0, name: data.name || "Unknown", mmr: 1000, rank: "Sentinel", last_request_time: 0,
        damage_breakdown: { physical: 0, magic: 0, fire: 0, lightning: 0, holy: 0 }
      };

      // AUTO-REPAIR
      if (p.kills < 0) p.kills = 0;
      if (p.deaths < 0) p.deaths = 0;
      if (p.assists < 0) p.assists = 0;
      if (p.damage_dealt < 0) p.damage_dealt = 0;
      if (p.damage_taken < 0) p.damage_taken = 0;
      if (p.phantom_hits < 0) p.phantom_hits = 0;

      const oldMmr = p.mmr || 1000;
      const oldKills = p.kills || 0;
      const oldDeaths = p.deaths || 0;
      const oldAssists = p.assists || 0;
      const oldDamage = p.damage_dealt || 0;
      const oldDamageTaken = p.damage_taken || 0;
      const oldPhantom = p.phantom_hits || 0;

      const now = Date.now();
      if (p.last_request_time && (now - p.last_request_time < 1500)) {
        return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many requests.' });
      }
      p.last_request_time = now;

      let currentSeason = await getCurrentSeasonCached();
      let isOldSeason = false;

      if (currentSeason && season_id !== undefined && parseInt(season_id) !== currentSeason.season_id) {
         isOldSeason = true;
      }

      if (!isOldSeason) {
        const safeKills = Math.max(data.kills || 0, 0);
        const safeDeaths = Math.max(data.deaths || 0, 0);
        const safeAssists = Math.max(data.assists || 0, 0);
        const safeDmgDealt = Math.max(data.damage_dealt || 0, 0);
        const safeDmgTaken = Math.max(data.damage_taken || 0, 0);
        const safePhantom = Math.max(data.phantom_hits || 0, 0);

        p.kills += safeKills;
        p.deaths += safeDeaths;
        p.assists += safeAssists;
        p.damage_dealt += safeDmgDealt;
        p.damage_taken += safeDmgTaken;
        p.phantom_hits += safePhantom;

        p.damage_breakdown = p.damage_breakdown || { physical: 0, magic: 0, fire: 0, lightning: 0, holy: 0 };
        if (data.damage_breakdown) {
          p.damage_breakdown.physical += Math.max(data.damage_breakdown.physical || 0, 0);
          p.damage_breakdown.magic += Math.max(data.damage_breakdown.magic || 0, 0);
          p.damage_breakdown.fire += Math.max(data.damage_breakdown.fire || 0, 0);
          p.damage_breakdown.lightning += Math.max(data.damage_breakdown.lightning || 0, 0);
          p.damage_breakdown.holy += Math.max(data.damage_breakdown.holy || 0, 0);
        }

        if (data.mmr !== undefined) {
          if (data.mmr === 1000 && p.mmr > 1050) {
            // Prevent override
          } else if (p.mmr !== undefined && Math.abs(data.mmr - p.mmr) > 2000) {
            // Prevent massive jump
          } else {
            p.mmr = data.mmr;
            p.rank = data.rank ?? p.rank;
          }
        }
      }

      if (data.is_session_end) p.sessions += 1;
      if (data.clear_pending_items) p.pending_items = [];
      p.name = data.name ?? p.name;
      p.level = data.level ?? p.level;
      p.is_mod_user = data.is_mod_user ?? p.is_mod_user;
      p.weapons = data.weapons ?? p.weapons;
      p.armors = data.armors ?? p.armors;
      p.talismans = data.talismans ?? p.talismans;
      p.stats = data.stats ?? p.stats;

      let hasChanges = (data.is_session_end || data.clear_pending_items || p.kills !== oldKills || p.deaths !== oldDeaths || p.assists !== oldAssists || p.damage_dealt !== oldDamage || p.damage_taken !== oldDamageTaken || p.phantom_hits !== oldPhantom || oldMmr !== p.mmr);
      
      if (hasChanges || !pData) {
        await supabase.from('players').upsert(p);
      }
      return res.status(200).json({ success: true, delta_sync: !hasChanges });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Write error' });
    }
  }
}