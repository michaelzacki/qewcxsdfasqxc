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

  // ====================================================
  // GET: Aktif bounty'leri döndür (tüm istemciler 30s polling)
  // ====================================================
  if (req.method === 'GET' && action === 'get_bounties') {
    try {
      const bounties = await redis.hgetall('bounties:active') || {};
      const result = [];
      for (const [id, val] of Object.entries(bounties)) {
        let b = typeof val === 'string' ? JSON.parse(val) : val;
        // 3 saat dolmuş mu kontrol et
        if (Date.now() - b.created_at > 3 * 60 * 60 * 1000) {
          await redis.hdel('bounties:active', id);
          continue;
        }
        // Kill progress ekle
        const kills = await redis.smembers(`bounty:${id}:kills`) || [];
        b.killed_members = kills;
        b.bounty_id = id;
        result.push(b);
      }
      
      let broadcastStr = await redis.get('global_broadcast');
      let broadcast = broadcastStr ? (typeof broadcastStr === 'string' ? JSON.parse(broadcastStr) : broadcastStr) : null;
      
      // Süresi geçmiş broadcast varsa temizle
      if (broadcast && broadcast.expires_at && Date.now() > broadcast.expires_at) {
         broadcast = null;
         await redis.del('global_broadcast');
      }

      return res.status(200).json({ bounties: result, broadcast: broadcast });
    } catch (err) {
      return res.status(500).json({ error: 'Redis error', details: err.message });
    }
  }

  // ====================================================
  // POST istekleri için API key kontrolü
  // ====================================================
  if (req.method === 'POST') {
    const clientApiKey = req.headers['x-api-key'];
    if (!clientApiKey || clientApiKey.trim() !== SECRET_API_KEY) {
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }

    const body = req.body;

    // ====================================================
    // POST: Encounter raporla (invader bir host grubuna denk geldi)
    // ====================================================
    if (action === 'encounter') {
      const { reporter_steam_id, reporter_name, host_members } = body;
      if (!reporter_steam_id || !host_members || host_members.length < 3)
        return res.status(400).json({ error: 'Invalid encounter data' });

      // Deterministik group key: sıralı SteamID hash
      const sortedIds = host_members.map(m => m.steam_id).sort();
      const groupKey = crypto.createHash('md5')
        .update(sortedIds.join(':')).digest('hex');

      try {
        let existing = await redis.hget('encounters', groupKey);
        if (existing) {
          existing = typeof existing === 'string' ? JSON.parse(existing) : existing;

          // 5dk geçmiş mi
          if (Date.now() - existing.first_time > 5 * 60 * 1000) {
            // Eski encounter, sıfırla ve yeniden başla
            const fresh = {
              host_members, reporters: [reporter_steam_id],
              first_time: Date.now()
            };
            await redis.hset('encounters', { [groupKey]: JSON.stringify(fresh) });
            return res.status(200).json({ status: 'encounter_reset' });
          }

          // Aynı host'a 2. karşılaşma (aynı reporter veya farklı reporter) → GANK TESPİTİ!
          const bountyId = 'bounty_' + crypto.randomBytes(6).toString('hex');
          const hostName = host_members.find(m =>
            m.team_type === 1)?.name || host_members[0].name;
          const bounty = {
            host_name: hostName,
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
          return res.status(200).json({
            status: 'gank_detected', bounty_id: bountyId
          });
        } else {
          // İlk encounter kaydı
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

    // ====================================================
    // POST: Bounty kill raporla
    // ====================================================
    if (action === 'bounty_kill') {
      const { bounty_id, killer_steam_id, killed_steam_id } = body;
      if (!bounty_id || !killer_steam_id || !killed_steam_id)
        return res.status(400).json({ error: 'Missing fields' });

      try {
        // Bounty hala aktif mi
        let bountyStr = await redis.hget('bounties:active', bounty_id);
        if (!bountyStr) return res.status(404).json({ error: 'Bounty expired' });
        let bounty = typeof bountyStr === 'string'
          ? JSON.parse(bountyStr) : bountyStr;

        // Öldürülen gerçekten bounty üyesi mi
        if (!bounty.member_steam_ids.includes(killed_steam_id))
          return res.status(400).json({ error: 'Not a bounty member' });

        // Kill'i kaydet
        await redis.sadd(`bounty:${bounty_id}:kills`, killed_steam_id);
        // 3 saat TTL
        await redis.expire(`bounty:${bounty_id}:kills`, 3 * 60 * 60);

        const kills = await redis.smembers(`bounty:${bounty_id}:kills`);
        const allKilled = bounty.member_steam_ids.every(
          id => kills.includes(id)
        );

        if (allKilled) {
          // Bounty tamamlandı — ödül killer'a yazılacak
          return res.status(200).json({
            status: 'bounty_completed',
            mmr_reward: bounty.mmr_reward,
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
    
    // ====================================================
    // POST: Live Kill Event (Herhangi bir kill)
    // ====================================================
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
        
        // live:killfeed listesine sol taraftan (baştan) ekle
        await redis.lpush('live:killfeed', JSON.stringify(killData));
        // Sadece son 50 kill tut, eskileri sil
        await redis.ltrim('live:killfeed', 0, 49);
        
        return res.status(200).json({ status: 'killfeed_updated' });
      } catch (err) {
        return res.status(500).json({ error: 'Redis error', details: err.message });
      }
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
