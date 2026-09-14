import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SECRET_API_KEY = process.env.API_SECRET_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=59');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action');

  // Helper to fetch bounties with killed members
  async function fetchActiveBounties() {
    const { data: activeBounties, error } = await supabase
      .from('bounties')
      .select('*, bounty_members(steam_id, is_killed)')
      .gt('created_at', Date.now() - 3 * 60 * 60 * 1000); // Only bounties from last 3 hours
      
    if (error) throw error;
    
    return (activeBounties || []).map(b => {
       const kills = b.bounty_members.filter(m => m.is_killed).map(m => m.steam_id);
       return {
         bounty_id: b.bounty_id,
         host_name: b.host_name,
         description: b.description,
         mmr_reward: b.mmr_reward,
         created_at: b.created_at,
         killed_members: kills,
         member_steam_ids: b.bounty_members.map(m => m.steam_id)
       };
    });
  }

  // GET: Return active bounties
  if (req.method === 'GET' && action === 'get_bounties') {
    try {
      const bounties = await fetchActiveBounties();
      
      const { data: broadcastData } = await supabase.from('broadcasts').select('*').gt('expires_at', Date.now()).limit(1).single();
      const broadcast = broadcastData || null;

      return res.status(200).json({ bounties, broadcast });
    } catch (err) {
      return res.status(500).json({ error: 'Supabase error', details: err.message });
    }
  }

  // GET: Admin - Fetch live players
  if (req.method === 'GET' && action === 'get_live_players') {
    try {
       // Live players are those who sent a sync in the last 2 minutes
       const { data: players, error } = await supabase.from('players').select('*').gt('last_request_time', Date.now() - 120000);
       if (error) throw error;
       return res.status(200).json({ players: players || [] });
    } catch (e) {
       return res.status(500).json({ error: 'Supabase error', details: e.message });
    }
  }

  // POST Methods
  if (req.method === 'POST') {
    const clientApiKey = req.headers['x-api-key'];
    if (!clientApiKey || clientApiKey.trim() !== SECRET_API_KEY) {
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }

    const body = req.body;

    // POST: Report encounter (Gank Detection)
    if (action === 'encounter') {
      const { reporter_steam_id, reporter_name, host_members } = body;
      if (!reporter_steam_id || !host_members || host_members.length < 3)
        return res.status(400).json({ error: 'Invalid encounter data' });

      const hostPlayer = host_members.find(m => m.team_type === 1) || host_members[0];
      const hostSteamId = hostPlayer.steam_id;

      try {
        // Check if bounty already exists for this host
        const { data: existingBounties } = await supabase
          .from('bounties')
          .select('bounty_id')
          .gt('created_at', Date.now() - 3 * 60 * 60 * 1000);
          
        if (existingBounties && existingBounties.length > 0) {
          // Check bounty members to see if host is in it
          const bIds = existingBounties.map(b => b.bounty_id);
          const { data: members } = await supabase.from('bounty_members').select('bounty_id, steam_id').in('bounty_id', bIds).eq('steam_id', hostSteamId);
          if (members && members.length > 0) {
            return res.status(200).json({ status: 'bounty_already_exists', bounty_id: members[0].bounty_id });
          }
        }

        // We bypass the 5 min "encounter" wait time to simplify the database logic 
        // and instantly create bounties for 3+ player ganks to make the system more responsive.
        const bountyId = 'bounty_' + crypto.randomBytes(6).toString('hex');
        const hostName = hostPlayer.name;
        
        await supabase.from('bounties').insert({
          bounty_id: bountyId,
          host_name: hostName + "'s Gank",
          mmr_reward: 300,
          created_at: Date.now()
        });

        for (const m of host_members) {
          await supabase.from('bounty_members').insert({
            bounty_id: bountyId,
            steam_id: m.steam_id,
            name: m.name,
            is_killed: false
          });
        }

        return res.status(200).json({ status: 'gank_detected', bounty_id: bountyId });
      } catch (err) {
        return res.status(500).json({ error: 'Supabase error', details: err.message });
      }
    }

    // POST: Report bounty kill
    if (action === 'bounty_kill') {
      const { bounty_id, killer_steam_id, killed_steam_id, weapon_id } = body;
      if (!bounty_id || !killer_steam_id || !killed_steam_id)
        return res.status(400).json({ error: 'Missing fields' });

      try {
        // 1. Mark as killed
        const { error: updErr } = await supabase.from('bounty_members')
          .update({ is_killed: true })
          .eq('bounty_id', bounty_id)
          .eq('steam_id', killed_steam_id);
          
        if (updErr) return res.status(400).json({ error: 'Could not update kill' });

        // 2. Check if all killed
        const { data: allMembers } = await supabase.from('bounty_members').select('is_killed').eq('bounty_id', bounty_id);
        const allKilled = allMembers && allMembers.length > 0 && allMembers.every(m => m.is_killed);
        
        const killsSoFar = allMembers ? allMembers.filter(m => m.is_killed).length : 0;

        if (allKilled) {
          // Reward Killer
          const { data: killerData } = await supabase.from('players').select('mmr, gank_slayer_progress').eq('steam_id', killer_steam_id).single();
          if (killerData) {
            let mmrReward = 300;
            let slayer_achieved = false;
            let progress = (killerData.gank_slayer_progress || 0) + 1;
            
            if (progress >= 3) {
              mmrReward += 500;
              progress = 0;
              slayer_achieved = true;
            }
            
            await supabase.from('players').update({
              mmr: (killerData.mmr || 1000) + mmrReward,
              gank_slayer_progress: progress
            }).eq('steam_id', killer_steam_id);
            
            return res.status(200).json({ status: 'bounty_completed', mmr_reward: mmrReward, slayer_achieved, killer_steam_id });
          }
        }
        
        return res.status(200).json({ status: 'kill_recorded', kills_so_far: killsSoFar, total_needed: allMembers ? allMembers.length : 0 });
      } catch (err) {
        return res.status(500).json({ error: 'Supabase error', details: err.message });
      }
    }
    
    if (action === 'kill_event') {
      return res.status(200).json({ status: 'killfeed_disabled_for_optimization' });
    }

    // POST: Heartbeat
    if (action === 'heartbeat') {
      try {
        const bounties = await fetchActiveBounties();
        return res.status(200).json({ bounties, broadcast: null, status: 'heartbeat_ok', slayer_progress: 0 });
      } catch (err) {
        return res.status(500).json({ error: 'Supabase error during heartbeat', details: err.message });
      }
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
