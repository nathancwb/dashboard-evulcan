// api/meta.js — Vercel Serverless Function: Meta Ads API Proxy
import fetch from 'node-fetch';

const {
  META_APP_ID,
  META_APP_SECRET,
  META_ACCESS_TOKEN,
} = process.env;

const API = 'https://graph.facebook.com/v24.0';

async function gql(path, token) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${API}/${path}${sep}access_token=${token}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d;
}

export default async function handler(req, res) {
  // CORS — allow any origin (dashboard can be embedded anywhere)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = META_ACCESS_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'META_ACCESS_TOKEN not configured' });
  }

  const { action, account_id, period = 'last_7d', since, until } = req.query;

  try {
    // ── List personal ad accounts ──────────────────────────────────────────
    if (action === 'accounts') {
      const [personal, businesses] = await Promise.all([
        gql('me/adaccounts?fields=id,name,account_status,currency&limit=200', token),
        gql('me/businesses?fields=id,name,owned_ad_accounts.limit(200){id,name,account_status,currency}&limit=50', token)
          .catch(() => ({ data: [] })),
      ]);

      const seen = new Set();
      const result = [];
      for (const acc of (personal.data || [])) {
        if (!seen.has(acc.id)) { seen.add(acc.id); result.push({ ...acc, group: 'Pessoal' }); }
      }
      for (const biz of (businesses.data || [])) {
        for (const acc of (biz.owned_ad_accounts?.data || [])) {
          if (!seen.has(acc.id)) { seen.add(acc.id); result.push({ ...acc, group: biz.name }); }
        }
      }
      return res.json({ data: result });
    }

    if (action === 'token_info') {
      const d = await gql(`debug_token?input_token=${token}&access_token=${META_APP_ID}|${META_APP_SECRET}`, token);
      return res.json(d);
    }

    if (!account_id) {
      return res.status(400).json({ error: 'account_id is required' });
    }

    // Build date parameter for Meta API
    let dateParam;
    if (period === 'custom' && since && until) {
      dateParam = `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`;
    } else if (period === 'this_year') {
      const now = new Date();
      const year = now.getFullYear();
      const todayStr = now.toISOString().split('T')[0];
      dateParam = `time_range=${encodeURIComponent(JSON.stringify({ since: `${year}-01-01`, until: todayStr }))}`;
    } else if (period === 'this_month') {
      const now = new Date();
      const firstDay = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
      const todayStr = now.toISOString().split('T')[0];
      dateParam = `time_range=${encodeURIComponent(JSON.stringify({ since: firstDay, until: todayStr }))}`;
    } else {
      dateParam = `date_preset=${period}`;
    }

    const fields = 'spend,impressions,clicks,reach,cpc,cpm,ctr,actions,action_values';

    const [summary, campaigns, daily] = await Promise.all([
      gql(`${account_id}/insights?fields=${fields}&${dateParam}`, token),
      gql(`${account_id}/campaigns?fields=id,name,status,effective_status,objective&limit=50`, token),
      gql(`${account_id}/insights?fields=spend,impressions,clicks&${dateParam}&time_increment=1&limit=366`, token),
    ]);

    const campInsights = await Promise.all(
      (campaigns.data || []).slice(0, 25).map(c =>
        gql(`${c.id}/insights?fields=spend,impressions,clicks,ctr,cpc,actions,action_values&${dateParam}`, token)
          .then(d => ({ ...c, ins: d.data?.[0] || null }))
          .catch(() => ({ ...c, ins: null }))
      )
    );

    return res.json({
      summary: summary.data?.[0] || null,
      campaigns: campInsights,
      daily: daily.data || [],
      account_id,
      period,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
