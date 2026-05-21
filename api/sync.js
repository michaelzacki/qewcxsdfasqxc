import { Redis } from '@upstash/redis';
import crypto from 'crypto';
import JSONBig from 'json-bigint';

const redis = Redis.fromEnv();
const JSONBigString = JSONBig({ storeAsString: true });

const CURRENT_SERVER_VERSION = "1.0.2";

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

    let body;
    try {
      const rawBody = await getRawBody(req);
      body = JSONBigString.parse(rawBody);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const { player_id: raw_player_id, data, mod_version, signature } = body;
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

      if (data.is_session_end) p.sessions += 1;

      p.name = data.name ?? p.name;
      p.level = data.level ?? p.level;
      p.is_mod_user = data.is_mod_user ?? p.is_mod_user;

      if (data.mmr !== undefined) {
        if (data.mmr === 1000 && p.mmr > 1050) {
          console.log(`[FAILSAFE] MMR Override Prevented for ${player_id}. Server: ${p.mmr}, Client sent: ${data.mmr}`);
          // Do not change p.mmr or p.rank
        } else {
          p.mmr = data.mmr;
          p.rank = data.rank ?? p.rank;
        }
      }

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
