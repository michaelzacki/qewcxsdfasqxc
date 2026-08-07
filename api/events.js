import { Redis } from '@upstash/redis';
import crypto from 'crypto';

const redis = Redis.fromEnv();
const SECRET_API_KEY = process.env.API_SECRET_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  
  // Vercel Edge Cache (10s fresh, 59s stale)
  res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=59');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action');

  if (req.method === 'GET' && action === 'get_bounties') {
    try {
      const bounties = await redis.hgetall('bounties:active') || {};
      const result = [];
      for (const [id, val] of Object.entries(bounties)) {
        let b = typeof val === 'string' ? JSON.parse(val) : val;
        // Check if 3 hours have passed
        if (Date.now() - b.created_at > 3 * 60 * 60 * 1000) {
          await redis.hdel('bounties:active', id);
          continue;
        }
        // Add kill progress
        const kills = await redis.smembers(`bounty:${id}:kills`) || [];
        b.killed_members = kills;
        b.bounty_id = id;
        result.push(b);
      }
      
      let broadcastStr = await redis.get('global_broadcast');
      let broadcast = broadcastStr ? (typeof broadcastStr === 'string' ? JSON.parse(broadcastStr) : broadcastStr) : null;
      
      // Clear expired broadcasts
      if (broadcast && broadcast.expires_at && Date.now() > broadcast.expires_at) {
         broadcast = null;
         await redis.del('global_broadcast');
      }

      return res.status(200).json({ bounties: result, broadcast: broadcast });
    } catch (err) {
      return res.status(500).json({ error: 'Redis error', details: err.message });
    }
  }

  if (req.method === 'GET' && action === 'get_live_players') {
    try {
       const keys = await redis.keys('live:player:*');
       if (keys.length === 0) return res.status(200).json({ players: [] });
       
       const values = await redis.mget(...keys);
       const players = values.map(v => typeof v === 'string' ? JSON.parse(v) : v);
       return res.status(200).json({ players });
    } catch (e) {
       return res.status(500).json({ error: 'Redis error', details: e.message });
    }
  }

  if (req.method === 'POST') {
    const clientApiKey = req.headers['x-api-key'];
    if (!clientApiKey || clientApiKey.trim() !== SECRET_API_KEY) {
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }

    const body = req.body;

    if (action === 'encounter') {
      const { reporter_steam_id, reporter_name, host_members } = body;
      if (!reporter_steam_id || !host_members || host_members.length < 3)
        return res.status(400).json({ error: 'Invalid encounter data' });

      // Deterministic group key: ordered SteamID hash
      const sortedIds = host_members.map(m => m.steam_id).sort();
      const groupKey = crypto.createHash('md5')
        .update(sortedIds.join(':')).digest('hex');

      try {
        // Check if bounty already exists for this exact host group
        const activeBounties = await redis.hgetall('bounties:active') || {};
        for (const [bId, bVal] of Object.entries(activeBounties)) {
          let b = typeof bVal === 'string' ? JSON.parse(bVal) : bVal;
          if (JSON.stringify(b.member_steam_ids) === JSON.stringify(sortedIds)) {
             if (!b.reporters.includes(reporter_steam_id)) {
                b.reporters.push(reporter_steam_id);
                await redis.hset('bounties:active', { [bId]: JSON.stringify(b) });
             }
             return res.status(200).json({ status: 'bounty_already_exists', bounty_id: bId });
          }
        }

        let existing = await redis.hget('encounters', groupKey);
        if (existing) {
          existing = typeof existing === 'string' ? JSON.parse(existing) : existing;

          // Check if 5 minutes passed
          if (Date.now() - existing.first_time > 5 * 60 * 1000) {
            // Old encounter, reset and restart
            const fresh = {
              host_members, reporters: [reporter_steam_id],
              first_time: Date.now()
            };
            await redis.hset('encounters', { [groupKey]: JSON.stringify(fresh) });
            return res.status(200).json({ status: 'encounter_reset' });
          }

          // 2nd encounter with the same host -> GANK DETECTED
          const bountyId = 'bounty_' + crypto.randomBytes(6).toString('hex');
          const hostName = host_members.find(m =>
            m.team_type === 1)?.name || host_members[0].name;
          const bounty = {
            host_name: hostName + "'s Gank",
            members: host_members,
            member_steam_ids: sortedIds,
            mmr_reward: 300,
            created_at: Date.now(),
            reporters: [...existing.reporters, reporter_steam_id]
          };
          await redis.hset('bounties:active', {
            [bountyId]: JSON.stringify(bounty)
          });
          await redis.hdel('encounters', groupKey);
          
          /*
          const broadcast = {
            id: 'gank_' + bountyId,
            title: 'GANK DETECTED',
            message: `Bounty created for ${hostName}! (+300 MMR)`,
            target_steam_ids: [],
            sound: 'None',
            created_at: Date.now(),
            expires_at: Date.now() + (10 * 1000)
          };
          await redis.set('global_broadcast', JSON.stringify(broadcast));
          */

          return res.status(200).json({
            status: 'gank_detected', bounty_id: bountyId
          });
        } else {
          // Log first encounter
          const encounter = {
            host_members, reporters: [reporter_steam_id],
            first_time: Date.now()
          };
          await redis.hset('encounters', {
            [groupKey]: JSON.stringify(encounter)
          });
          return res.status(200).json({ status: 'encounter_logged' });
        }
      } catch (err) {
        return res.status(500).json({ error: 'Redis error', details: err.message });
      }
    }

    if (action === 'bounty_kill') {
      const { bounty_id, killer_steam_id, killed_steam_id, weapon_id } = body;
      if (!bounty_id || !killer_steam_id || !killed_steam_id)
        return res.status(400).json({ error: 'Missing fields' });

      try {
        // Check if bounty is still active
        let bountyStr = await redis.hget('bounties:active', bounty_id);
        if (!bountyStr) return res.status(404).json({ error: 'Bounty expired' });
        let bounty = typeof bountyStr === 'string'
          ? JSON.parse(bountyStr) : bountyStr;

        // Verify weapon if required
        if (bounty.target_weapon_id) {
          if (!weapon_id) return res.status(400).json({ status: 'wrong_weapon', error: 'Weapon required' });
          const wId = parseInt(weapon_id, 10);
          const tId = parseInt(bounty.target_weapon_id, 10);
          
          if (tId % 100 === 0) {
            // Any upgrade level of this base weapon
            if (wId - (wId % 100) !== tId) {
               return res.status(400).json({ status: 'wrong_weapon', error: 'Used wrong weapon type' });
            }
          } else {
            // Exact weapon and level match
            if (wId !== tId) {
               return res.status(400).json({ status: 'wrong_weapon', error: 'Used wrong weapon or upgrade level' });
            }
          }
        }

        // Verify victim is a bounty member
        if (!bounty.member_steam_ids.includes(killed_steam_id))
          return res.status(400).json({ error: 'Not a bounty member' });

        // Record kill
        await redis.sadd(`bounty:${bounty_id}:kills`, killed_steam_id);
        // 3 hours TTL
        await redis.expire(`bounty:${bounty_id}:kills`, 3 * 60 * 60);

        const kills = await redis.smembers(`bounty:${bounty_id}:kills`);
        const allKilled = bounty.member_steam_ids.every(
          id => kills.includes(id)
        );

        if (allKilled) {
          // Bounty completed - reward will be given to the killer
          const mmrReward = bounty.mmr_reward || 300;
          
          try {
             let killerStr = await redis.hget('globals_hash', `steam:${killer_steam_id}`);
             if (killerStr) {
                let killerObj = typeof killerStr === 'string' ? JSON.parse(killerStr) : killerStr;
                killerObj.mmr = (killerObj.mmr || 1000) + mmrReward;
                await redis.hset('globals_hash', { [`steam:${killer_steam_id}`]: JSON.stringify(killerObj) });
             }
          } catch(e) {
             console.error("Failed to add MMR for bounty", e);
          }
          
          return res.status(200).json({
            status: 'bounty_completed',
            mmr_reward: mmrReward,
            killer_steam_id
          });
        }
        return res.status(200).json({
          status: 'kill_recorded',
          kills_so_far: kills.length,
          total_needed: bounty.member_steam_ids.length
        });
      } catch (err) {
        return res.status(500).json({ error: 'Redis error', details: err.message });
      }
    }

    if (action === 'kill_event') {
      const { killer_name, victim_name, weapon, is_mod_user } = body;
      if (!killer_name || !victim_name) return res.status(400).json({ error: 'Missing killer or victim name' });

      try {
        const killData = {
          killer: killer_name,
          victim: victim_name,
          weapon: weapon || 'Unknown',
          is_mod: !!is_mod_user,
          time: Date.now()
        };
        
        // Push to the left (start) of the live:killfeed list
        await redis.lpush('live:killfeed', JSON.stringify(killData));
        // Keep only the last 50 kills, remove older ones
        await redis.ltrim('live:killfeed', 0, 49);
        
        return res.status(200).json({ status: 'killfeed_updated' });
      } catch (err) {
        return res.status(500).json({ error: 'Redis error', details: err.message });
      }
    }

    if (action === 'heartbeat') {
      const { steam_id, name, map_id, hp, max_hp, fp, max_fp, stamina, max_stamina } = body;
      
      if (steam_id) {
         try {
           const playerData = { 
             steam_id, name, map_id, 
             hp, max_hp, fp, max_fp, stamina, max_stamina, 
             last_seen: Date.now() 
           };
           // Save player data with 30s TTL
           await redis.setex(`live:player:${steam_id}`, 30, JSON.stringify(playerData));
         } catch (e) {
           console.error("Live Tracker redis error:", e);
         }
      }
      
      // Return bounties and broadcast data
      try {
        const bounties = await redis.hgetall('bounties:active') || {};
        const result = [];
        for (const [id, val] of Object.entries(bounties)) {
          let b = typeof val === 'string' ? JSON.parse(val) : val;
          if (Date.now() - b.created_at > 3 * 60 * 60 * 1000) {
            await redis.hdel('bounties:active', id);
            continue;
          }
          const kills = await redis.smembers(`bounty:${id}:kills`) || [];
          b.killed_members = kills;
          b.bounty_id = id;
          result.push(b);
        }
        
        let broadcastStr = await redis.get('global_broadcast');
        let broadcast = broadcastStr ? (typeof broadcastStr === 'string' ? JSON.parse(broadcastStr) : broadcastStr) : null;
        if (broadcast && broadcast.expires_at && Date.now() > broadcast.expires_at) {
           broadcast = null;
           await redis.del('global_broadcast');
        }

        return res.status(200).json({ bounties: result, broadcast: broadcast, status: 'heartbeat_ok' });
      } catch (err) {
        return res.status(500).json({ error: 'Redis error during heartbeat', details: err.message });
      }
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
