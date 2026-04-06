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
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = META_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'META_ACCESS_TOKEN not configured' });

  const { action, account_id, period = 'last_7d', since, until } = req.query;

  try {
    if (action === 'accounts') {
      const [personal, businesses] = await Promise.all([
        gql('me/adaccounts?fields=id,name,account_status,currency&limit=200', token),
        gql('me/businesses?fields=id,name,owned_ad_accounts.limit(200){id,name,account_status,currency}&limit=50', token).catch(() => ({ data: [] }))
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

    if (!account_id) return res.status(400).json({ error: 'account_id is required' });

    let dateParam;
    let edgeParams;
    if (period === 'custom' && since && until) {
      dateParam = `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`;
      edgeParams = `.time_range({"since":"${since}","until":"${until}"})`;
    } else if (period === 'this_year') {
      const now = new Date();
      const year = now.getFullYear();
      const todayStr = now.toISOString().split('T')[0];
      dateParam = `time_range=${encodeURIComponent(JSON.stringify({ since: `${year}-01-01`, until: todayStr }))}`;
      edgeParams = `.time_range({"since":"${year}-01-01","until":"${todayStr}"})`;
    } else if (period === 'this_month') {
      const now = new Date();
      const firstDay = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
      const todayStr = now.toISOString().split('T')[0];
      dateParam = `time_range=${encodeURIComponent(JSON.stringify({ since: firstDay, until: todayStr }))}`;
      edgeParams = `.time_range({"since":"${firstDay}","until":"${todayStr}"})`;
    } else {
      dateParam = `date_preset=${period}`;
      edgeParams = `.date_preset(${period})`;
    }

    const fields = 'spend,impressions,clicks,reach,frequency,cpc,cpm,ctr,actions,action_values,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p95_watched_actions,video_p100_watched_actions,video_play_actions';
    const edgeInsights = 'spend,impressions,clicks,reach,frequency,ctr,cpc,cpm,actions,action_values,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p95_watched_actions,video_p100_watched_actions,video_play_actions';
    
    // N+1 Optimization: Graph API Field Expansion fetching max 50 items inherently without loops
    const [summary, daily, campaignsResponse, adsResponse, adsetsResponse, accInfoResponse] = await Promise.all([
      gql(`${account_id}/insights?fields=${fields}&${dateParam}`, token),
      gql(`${account_id}/insights?fields=spend,impressions,clicks,actions&${dateParam}&time_increment=1&limit=366`, token),
      gql(`${account_id}/campaigns?fields=id,name,status,effective_status,objective,insights${edgeParams}{${edgeInsights}}&limit=50`, token).catch(()=>({data:[]})),
      gql(`${account_id}/ads?fields=id,name,status,effective_status,campaign_id,adset_id,creative{thumbnail_url,image_url},insights${edgeParams}{${edgeInsights}}&limit=50`, token).catch(()=>({data:[]})),
      gql(`${account_id}/adsets?fields=id,name,status,effective_status,campaign_id,insights${edgeParams}{${edgeInsights}}&limit=50`, token).catch(()=>({data:[]})),
      gql(`${account_id}?fields=balance,currency,amount_spent,spend_cap,funding_source_details`, token).catch(()=>null)
    ]);

    // Format like frontend expects natively
    const campInsights = (campaignsResponse.data || []).map(c => ({
      ...c,
      ins: c.insights?.data?.[0] || null
    }));

    const adInsights = (adsResponse.data || []).map(a => ({
      ...a,
      ins: a.insights?.data?.[0] || null
    }));

    const adsetInsights = (adsetsResponse.data || []).map(a => ({
      ...a,
      ins: a.insights?.data?.[0] || null
    }));

    // Dedicated video insights call at campaign level (field expansion does NOT expose these)
    const videoFields = 'video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p95_watched_actions,video_p100_watched_actions,video_play_actions';
    const videoInsightsResponse = await gql(
      `${account_id}/insights?fields=${videoFields}&${dateParam}&level=campaign&limit=200`,
      token
    ).catch(() => ({ data: [] }));

    return res.json({
      summary: summary.data?.[0] || null,
      campaigns: campInsights,
      adsets: adsetInsights,
      ads: adInsights,
      daily: daily.data || [],
      video_data: videoInsightsResponse.data || [],
      account_info: accInfoResponse || null,
      account_id,
      period,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
