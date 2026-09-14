import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const HMAC_SECRET = process.env.HMAC_SECRET_KEY;

export const config = {
  api: {
    bodyParser: true,
  },
};

function verifySignature(payload, signature) {
  if (!HMAC_SECRET || !signature) return false;
  const canonical = `${payload.key}|${payload.steam_id}|${payload.hwid}`;
  const serverSig = crypto.createHmac('sha256', HMAC_SECRET).update(canonical).digest('hex');
  return serverSig === signature;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { key, steam_id, hwid, signature } = req.body;

  if (!key || !steam_id || !hwid) {
    return res.status(400).json({ valid: false, reason: 'missing_params', message: 'Missing parameters.' });
  }

  if (steam_id === "0") {
    return res.status(400).json({ valid: false, reason: 'invalid_steam', message: 'Could not verify Steam ID.' });
  }
  
  if (!verifySignature({ key, steam_id, hwid }, signature)) {
    return res.status(403).json({ valid: false, reason: 'invalid_signature', message: 'Data integrity could not be verified. (Tampering Detected)' });
  }

  try {
    // Check Bans
    const { data: bans } = await supabase.from('bans').select('value').in('value', [steam_id, hwid]);
    if (bans && bans.length > 0) {
      return res.status(403).json({ valid: false, reason: 'banned', message: 'This hardware or account has been PERMANENTLY BANNED from the mod.' });
    }

    // Check License
    const { data: license } = await supabase.from('licenses').select('*').eq('key', key).single();
    if (!license) {
      return res.status(404).json({ valid: false, reason: 'invalid_key', message: 'License key is invalid or not found.' });
    }

    if (license.banned) {
      return res.status(403).json({ valid: false, reason: 'banned', message: 'This license key has been revoked.' });
    }

    const now = new Date();

    if (!license.expires_at) {
      const expiresDate = new Date(now.getTime() + license.duration_days * 24 * 60 * 60 * 1000);
      license.expires_at = expiresDate.toISOString();
    }

    const expiresAt = new Date(license.expires_at);
    if (now > expiresAt) {
      return res.status(403).json({ valid: false, reason: 'expired', message: 'Your license has expired.' });
    }

    let accounts = license.accounts || [];
    let devices = license.devices || [];
    let updated = false;

    if (!accounts.includes(steam_id)) {
      if (accounts.length >= license.max_accounts) {
        return res.status(403).json({ valid: false, reason: 'max_accounts_reached', message: `This key has reached the maximum Steam account limit (${license.max_accounts}).` });
      }
      accounts.push(steam_id);
      updated = true;
    }

    if (!devices.includes(hwid)) {
      if (devices.length >= license.max_devices) {
        return res.status(403).json({ valid: false, reason: 'max_devices_reached', message: `This key has reached the maximum hardware limit (${license.max_devices}).` });
      }
      devices.push(hwid);
      updated = true;
    }

    if (updated || !license.expires_at) { // if expires_at was just set or arrays updated
      await supabase.from('licenses').update({
         expires_at: license.expires_at,
         accounts: accounts,
         devices: devices
      }).eq('key', key);
    }

    const daysRemaining = Math.floor((expiresAt - now) / (1000 * 60 * 60 * 24));

    return res.status(200).json({
      valid: true,
      expires_at: license.expires_at,
      days_remaining: daysRemaining,
      max_devices: license.max_devices,
      registered_devices: devices.length,
      max_accounts: license.max_accounts,
      registered_accounts: accounts.length
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ valid: false, reason: 'server_error', message: 'A server error occurred.' });
  }
}