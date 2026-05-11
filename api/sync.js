import { Redis } from '@upstash/redis';

// Vercel'in oluşturduğu gizli değişkenleri otomatik çeker
const redis = Redis.fromEnv();

export default async function handler(req, res) {
  // C++ DLL veya tarayıcıdan gelen isteklere izin veren CORS ayarları
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Ön kontrol (Preflight) isteklerine anında OK yanıtı ver
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // C++ modundan GET isteği gelirse (Oyuncular global veriyi çekiyor)
  if (req.method === 'GET') {
    try {
      const globals = await redis.get('globals') || {};
      return res.status(200).json(globals);
    } catch (error) {
      return res.status(500).json({ error: 'Database read error' });
    }
  }

  // C++ modundan POST isteği gelirse (Oyuncu kendi verisini gönderiyor)
  if (req.method === 'POST') {
    const { player_id, data } = req.body;

    if (!player_id) {
      return res.status(400).json({ error: 'player_id needed' });
    }

    try {
      let currentGlobals = await redis.get('globals') || {};
      currentGlobals[player_id] = data;
      await redis.set('globals', currentGlobals);
      
      return res.status(200).json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: 'Database write error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
