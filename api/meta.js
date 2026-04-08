// api/meta.js — Vercel Serverless Function: Meta Ads API Proxy
import fetch from 'node-fetch';

const {
  META_APP_ID,
  META_APP_SECRET,
  META_ACCESS_TOKEN,
} = process.env;

const API = 'https://graph.facebook.com/v25.0';

async function gql(path, token) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${API}/${path}${sep}access_token=${token}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d;
}

async function postMeta(path, body, token) {
  const r = await fetch(`${API}/${path}?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d;
}

// ── Find Instagram Business Account linked to this ad account ──────────
async function findIgAccount(account_id, token) {
  try {
    const r = await gql(`${account_id}?fields=instagram_accounts{id,username,followers_count,name}`, token);
    const list = r?.instagram_accounts?.data || [];
    if (list.length > 0 && list[0].id) return list[0];
  } catch(e) {}
  try {
    const pages = await gql('me/accounts?fields=id,name,instagram_business_account{id,username,followers_count}&limit=50', token);
    for (const page of (pages?.data || [])) {
      const iga = page.instagram_business_account;
      if (iga?.id) return iga;
    }
  } catch(e) {}
  return null;
}

// ── Get follower growth for a period from IG Insights ─────────────────
async function getIgFollowerGrowth(igId, sinceDate, untilDate, token) {
  try {
    const since = Math.floor(new Date(sinceDate + 'T00:00:00').getTime() / 1000);
    const until = Math.floor(new Date(untilDate + 'T23:59:59').getTime() / 1000);
    const r = await gql(
      `${igId}/insights?metric=follower_count&period=day&since=${since}&until=${until}`,
      token
    );
    const values = r?.data?.[0]?.values || [];
    const netGrowth = values.reduce((acc, v) => acc + (parseInt(v.value) || 0), 0);
    return { growth: netGrowth };
  } catch(e) {
    return null;
  }
}

// ── Resolve date range for a period preset ────────────────────────────
function resolveDateRange(period, since, until) {
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  if (period === 'custom' && since && until) return { since, until };
  if (period === 'this_year') return { since: `${now.getFullYear()}-01-01`, until: todayStr };
  if (period === 'this_month') {
    return { since: `${now.getFullYear()}-${pad(now.getMonth()+1)}-01`, until: todayStr };
  }
  const presetDays = { today: 0, yesterday: 1, last_7d: 7, last_30d: 30 };
  if (period in presetDays) {
    const days = presetDays[period];
    const from = new Date(now);
    from.setDate(from.getDate() - (days || 1));
    return { since: from.toISOString().split('T')[0], until: todayStr };
  }
  return null;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = META_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'META_ACCESS_TOKEN not configured' });

  // ── POST: Campaign Management Actions ─────────────────────────────────
  if (req.method === 'POST') {
    try {
      const { action, account_id, payload } = req.body;

      if (!action) return res.status(400).json({ error: 'action is required' });

      // Create Campaign (Step 1)
      if (action === 'create_campaign') {
        if (!account_id) return res.status(400).json({ error: 'account_id required' });
        const budgetCents = Math.round((payload.daily_budget_brl || 50) * 100);
        const body = {
          name: payload.name,
          objective: payload.objective || 'OUTCOME_TRAFFIC',
          status: 'PAUSED',
          special_ad_categories: payload.special_ad_categories || [],
          daily_budget: budgetCents,
          buying_type: 'AUCTION',
        };
        const r = await postMeta(`act_${account_id}/campaigns`, body, token);
        return res.json({ success: true, campaign_id: r.id });
      }

      // Create Ad Set (Step 2)
      if (action === 'create_adset') {
        if (!account_id) return res.status(400).json({ error: 'account_id required' });
        // Build targeting object
        const targeting = {
          age_min: payload.age_min || 18,
          age_max: payload.age_max || 65,
        };
        if (payload.genders && payload.genders.length > 0) {
          targeting.genders = payload.genders;
        }
        if (payload.countries) {
          targeting.geo_locations = { countries: payload.countries };
        } else {
          targeting.geo_locations = { countries: ['BR'] };
        }
        if (payload.city_keys && payload.city_keys.length > 0) {
          targeting.geo_locations.cities = payload.city_keys.map(k => ({ key: k }));
        }
        if (payload.interests && payload.interests.length > 0) {
          targeting.interests = payload.interests; // [{ id, name }]
        }

        const budgetCents = Math.round((payload.daily_budget_brl || 50) * 100);
        const body = {
          name: payload.name,
          campaign_id: payload.campaign_id,
          daily_budget: budgetCents,
          billing_event: 'IMPRESSIONS',
          optimization_goal: payload.optimization_goal || 'LINK_CLICKS',
          bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
          targeting,
          status: 'PAUSED',
        };
        const r = await postMeta(`act_${account_id}/adsets`, body, token);
        return res.json({ success: true, adset_id: r.id });
      }

      // Upload Image (Step 3)
      if (action === 'upload_image') {
        if (!account_id) return res.status(400).json({ error: 'account_id required' });
        // payload.bytes = base64 encoded image
        const r = await postMeta(`act_${account_id}/adimages`, { bytes: payload.bytes }, token);
        // Response: { images: { filename: { hash, url } } }
        const images = Object.values(r.images || {});
        const hash = images[0]?.hash;
        const url = images[0]?.url;
        return res.json({ success: true, image_hash: hash, image_url: url });
      }

      // Create Ad Creative (Step 4)
      if (action === 'create_creative') {
        if (!account_id) return res.status(400).json({ error: 'account_id required' });
        const storySpec = {
          page_id: payload.page_id,
        };

        if (payload.cta === 'SEND_MESSAGE') {
          storySpec.link_data = {
            image_hash: payload.image_hash,
            message: payload.primary_text,
            name: payload.headline,
            description: payload.description || '',
            call_to_action: {
              type: 'SEND_MESSAGE',
              value: { app_destination: 'MESSAGING_INSTAGRAM_DIRECT_MESSAGE' },
            },
          };
        } else {
          storySpec.link_data = {
            image_hash: payload.image_hash,
            message: payload.primary_text,
            link: payload.destination_url || 'https://www.facebook.com',
            name: payload.headline,
            description: payload.description || '',
            call_to_action: {
              type: payload.cta || 'LEARN_MORE',
            },
          };
        }

        const body = {
          name: payload.name || payload.headline,
          object_story_spec: storySpec,
        };
        const r = await postMeta(`act_${account_id}/adcreatives`, body, token);
        return res.json({ success: true, creative_id: r.id });
      }

      // Create Ad (Step 5)
      if (action === 'create_ad') {
        if (!account_id) return res.status(400).json({ error: 'account_id required' });
        const body = {
          name: payload.name,
          adset_id: payload.adset_id,
          creative: { creative_id: payload.creative_id },
          status: 'PAUSED',
        };
        const r = await postMeta(`act_${account_id}/ads`, body, token);
        return res.json({ success: true, ad_id: r.id });
      }

      // Update Status: pause/activate campaign, adset, or ad
      if (action === 'update_status') {
        const { entity_id, status } = payload;
        if (!entity_id || !status) return res.status(400).json({ error: 'entity_id and status required' });
        const r = await postMeta(entity_id, { status }, token);
        return res.json({ success: true, result: r });
      }

      // Search interests by keyword (for targeting)
      if (action === 'search_interests') {
        const { keyword } = payload;
        const r = await gql(`search?type=adinterest&q=${encodeURIComponent(keyword)}&limit=10`, token);
        return res.json({ success: true, interests: r.data || [] });
      }

      // Get Facebook Pages linked to this token (needed for creatives)
      if (action === 'get_pages') {
        const r = await gql('me/accounts?fields=id,name,picture&limit=50', token);
        return res.json({ success: true, pages: r.data || [] });
      }

      return res.status(400).json({ error: `Unknown action: ${action}` });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── GET: Insights & Data ───────────────────────────────────────────────
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
    const attrWindow = 'action_attribution_windows=[%227d_click%22,%221d_view%22]&action_breakdowns=action_type';

    const [summary, daily, campaignsResponse, adsResponse, adsetsResponse, accInfoResponse] = await Promise.all([
      gql(`${account_id}/insights?fields=${fields}&${dateParam}&${attrWindow}`, token),
      gql(`${account_id}/insights?fields=spend,impressions,clicks,actions&${dateParam}&time_increment=1&limit=366&${attrWindow}`, token),
      gql(`${account_id}/campaigns?fields=id,name,status,effective_status,objective,insights${edgeParams}{${edgeInsights}}&limit=50`, token).catch(()=>({data:[]})),
      gql(`${account_id}/ads?fields=id,name,status,effective_status,campaign_id,adset_id,creative{thumbnail_url,image_url},insights${edgeParams}{${edgeInsights}}&limit=50`, token).catch(()=>({data:[]})),
      gql(`${account_id}/adsets?fields=id,name,status,effective_status,campaign_id,insights${edgeParams}{${edgeInsights}}&limit=50`, token).catch(()=>({data:[]})),
      gql(`${account_id}?fields=balance,currency,amount_spent,spend_cap,funding_source_details`, token).catch(()=>null),
    ]);

    // Instagram follower growth
    let igFollowerGrowth = null;
    let igFollowersTotal = 0;
    try {
      const igAccount = await findIgAccount(account_id, token);
      if (igAccount) {
        igFollowersTotal = igAccount.followers_count || 0;
        const range = resolveDateRange(period, since, until);
        if (range) {
          const growth = await getIgFollowerGrowth(igAccount.id, range.since, range.until, token);
          igFollowerGrowth = growth;
        }
      }
    } catch(e) {}

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

    const videoFields = 'campaign_id,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p95_watched_actions,video_p100_watched_actions,video_play_actions';
    let videoData = [];
    let videoError = null;
    try {
      const videoResp = await gql(
        `${account_id}/insights?fields=${videoFields}&${dateParam}&level=campaign&limit=200`,
        token
      );
      videoData = videoResp.data || [];
    } catch(e) {
      videoError = e.message;
    }

    return res.json({
      summary: summary.data?.[0] || null,
      campaigns: campInsights,
      adsets: adsetInsights,
      ads: adInsights,
      daily: daily.data || [],
      video_data: videoData,
      video_error: videoError,
      account_info: accInfoResponse || null,
      account_id,
      period,
      ig_follower_growth: igFollowerGrowth?.growth ?? null,
      ig_followers_total: igFollowersTotal,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
