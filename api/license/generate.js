import { Redis } from '@upstash/redis';
import crypto from 'crypto';

const redis = Redis.fromEnv();
const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const adminSecret = req.headers['x-admin-secret'];
  if (!adminSecret || adminSecret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'UNAUTHORIZED: Hatalı Admin Şifresi' });
  }

  const { duration_days, max_devices, max_accounts } = req.body;

  if (!duration_days || !max_devices || !max_accounts) {
    return res.status(400).json({ error: 'Eksik parametreler.' });
  }

  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let key = 'ERVS';
  for (let i = 0; i < 3; i++) {
    key += '-';
    for (let j = 0; j < 4; j++) {
      key += chars[crypto.randomInt(chars.length)];
    }
  }

  const licenseData = {
    duration_days: parseInt(duration_days),
    max_devices: parseInt(max_devices),
    max_accounts: parseInt(max_accounts),
    accounts: [],
    devices: [],
    banned: false
  };

  await redis.set(`license:${key}`, JSON.stringify(licenseData));

  return res.status(200).json({
    success: true,
    key: key,
    data: licenseData
  });
}
