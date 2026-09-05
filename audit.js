require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── Environment Validation ──
const WP_URL = (process.env.WP_URL && process.env.WP_URL.trim()) ? process.env.WP_URL.trim() : 'https://brightcelebrity.com/';
const WP_USERNAME = process.env.WP_USERNAME;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GSC_CREDENTIALS = process.env.GSC_CREDENTIALS;

if (!GEMINI_API_KEY) {
  console.error('[Audit Error] GEMINI_API_KEY environment variable is missing.');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

/**
 * Parses Google Service Account credentials safely from process.env.
 */
function getGscCredentials() {
  if (!GSC_CREDENTIALS) {
    console.warn('[Audit Warning] GSC_CREDENTIALS is not set.');
    return null;
  }
  try {
    return JSON.parse(GSC_CREDENTIALS);
  } catch (err) {
    console.warn('[Audit Warning] Failed to parse GSC_CREDENTIALS JSON:', err.message);
    return null;
  }
}

/**
 * Fetches the last 3 days of Search Console performance data (clicks, impressions, top queries).
 */
async function fetchGscPerformanceData() {
  console.log('[Step 1/4] Fetching Google Search Console performance data...');
  const credentials = getGscCredentials();
  if (!credentials) {
    console.log('  ↳ Skipping GSC fetch due to missing or invalid credentials.');
    return { status: 'skipped', rows: [], summary: 'GSC credentials not available' };
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/webmasters',
        'https://www.googleapis.com/auth/webmasters.readonly'
      ]
    });

    const searchconsole = google.searchconsole({ version: 'v1', auth });

    // Derive siteUrl from WP_URL
    const parsedWpUrl = new URL(WP_URL);
    let targetSiteUrl = `${parsedWpUrl.protocol}//${parsedWpUrl.host}/`;

    // Attempt to discover registered sites for this service account
    try {
      const sitesList = await searchconsole.sites.list();
      const entries = sitesList.data.siteEntry || [];
      if (entries.length > 0) {
        console.log(`  ↳ Found ${entries.length} verified GSC properties.`);
        const matched = entries.find(e => e.siteUrl.includes(parsedWpUrl.host));
        if (matched) {
          targetSiteUrl = matched.siteUrl;
        } else {
          targetSiteUrl = entries[0].siteUrl;
        }
      }
    } catch (siteErr) {
      console.warn(`  ↳ [GSC Notice] Could not list sites (${siteErr.message}). Using fallback: ${targetSiteUrl}`);
    }

    console.log(`  ↳ Querying performance data for: ${targetSiteUrl}`);

    // GSC data has a standard 2-3 day latency window
    const endDateObj = new Date();
    endDateObj.setDate(endDateObj.getDate() - 2);
    const startDateObj = new Date();
    startDateObj.setDate(startDateObj.getDate() - 5);

    const startDate = startDateObj.toISOString().split('T')[0];
    const endDate = endDateObj.toISOString().split('T')[0];

    const response = await searchconsole.searchanalytics.query({
      siteUrl: targetSiteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['query', 'page'],
        rowLimit: 25
      }
    });

    const rows = response.data.rows || [];
    console.log(`  ↳ Received ${rows.length} performance query rows from GSC.`);

    const topQueries = rows.map(r => ({
      query: r.keys ? r.keys[0] : 'N/A',
      page: r.keys && r.keys[1] ? r.keys[1] : 'N/A',
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      ctr: r.ctr ? (r.ctr * 100).toFixed(2) + '%' : '0%',
      position: r.position ? r.position.toFixed(1) : 'N/A'
    }));

    return {
      status: 'success',
      siteUrl: targetSiteUrl,
      dateRange: `${startDate} to ${endDate}`,
      totalRows: rows.length,
      topQueries
    };
  } catch (error) {
    const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
    console.warn(`  ↳ [GSC Warning] Failed to query search analytics: ${errorMsg}`);
    return {
      status: 'error',
      message: errorMsg,
      topQueries: []
    };
  }
}

/**
 * Fetches the 5 most recent published posts from WordPress REST API.
 */
async function fetchRecentWordPressPosts() {
  console.log('[Step 2/4] Fetching 5 most recent WordPress posts...');
  const wpBaseUrl = WP_URL.replace(/\/$/, '');
  const endpoint = `${wpBaseUrl}/wp-json/wp/v2/posts?per_page=5&orderby=date&order=desc&_nocache=${Date.now()}`;

  // Public endpoint headers with browser emulation to bypass CDN blocks
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
  };

  try {
    const response = await axios.get(endpoint, { headers, timeout: 15000 });
    const posts = response.data || [];

    console.log(`  ↳ Successfully fetched ${posts.length} WordPress posts.`);

    return posts.map(p => {
      const cleanTitle = p.title?.rendered ? cheerio.load(p.title.rendered).text().trim() : p.slug;
      const cleanExcerpt = p.excerpt?.rendered ? cheerio.load(p.excerpt.rendered).text().replace(/\s+/g, ' ').trim() : '';
      const cleanContent = p.content?.rendered ? cheerio.load(p.content.rendered).text().replace(/\s+/g, ' ').trim().slice(0, 500) : '';

      return {
        postId: p.id,
        title: cleanTitle,
        slug: p.slug,
        link: p.link,
        date: p.date,
        excerpt: cleanExcerpt,
        contentSnippet: cleanContent
      };
    });
  } catch (err) {
    console.error('Audit Fatal Error Details:', err.response?.data || err.response?.status || err.message);

    // Fallback attempt: if public GET was blocked, retry with Basic Auth if credentials are present
    if (WP_USERNAME && WP_APP_PASSWORD) {
      try {
        console.log('  ↳ Retrying WordPress posts fetch with Basic Auth fallback...');
        const credentials = `${WP_USERNAME}:${WP_APP_PASSWORD}`;
        const token = Buffer.from(credentials).toString('base64');
        const authHeaders = {
          ...headers,
          'Authorization': `Basic ${token}`
        };
        const authResp = await axios.get(endpoint, { headers: authHeaders, timeout: 15000 });
        const posts = authResp.data || [];
        console.log(`  ↳ Successfully fetched ${posts.length} WordPress posts (via auth fallback).`);
        return posts.map(p => {
          const cleanTitle = p.title?.rendered ? cheerio.load(p.title.rendered).text().trim() : p.slug;
          const cleanExcerpt = p.excerpt?.rendered ? cheerio.load(p.excerpt.rendered).text().replace(/\s+/g, ' ').trim() : '';
          const cleanContent = p.content?.rendered ? cheerio.load(p.content.rendered).text().replace(/\s+/g, ' ').trim().slice(0, 500) : '';

          return {
            postId: p.id,
            title: cleanTitle,
            slug: p.slug,
            link: p.link,
            date: p.date,
            excerpt: cleanExcerpt,
            contentSnippet: cleanContent
          };
        });
      } catch (authErr) {
        console.error('Audit Fatal Error Details (Auth Fallback):', authErr.response?.data || authErr.response?.status || authErr.message);
        throw authErr;
      }
    }
    throw err;
  }
}

/**
 * Passes GSC performance data and WP posts to Gemini for AI SEO expert analysis.
 */
async function analyzeWithGemini(wpPosts, gscData) {
  console.log('[Step 3/4] Running Gemini AI SEO Expert Analysis...');

  const prompt = `You are an elite, world-class Senior SEO Strategist and Google Search Console Optimization Architect for a high-traffic entertainment, celebrity, and news media publication.

Below is the recent performance data from Google Search Console and the 5 most recent published articles from WordPress.

### GOOGLE SEARCH CONSOLE DATA (Last 3 Days):
${JSON.stringify(gscData, null, 2)}

### 5 RECENT WORDPRESS ARTICLES:
${JSON.stringify(wpPosts, null, 2)}

### YOUR TASK:
1. Conduct an in-depth SEO audit on each of the 5 articles.
2. Diagnose why these articles have low clicks, low impressions, or weak search visibility (e.g., weak search intent match, missing numbers/power words, passive phrasing, missing entity terms, low CTR appeal, or title cannibalization).
3. Formulate an actionable fix for EVERY article. Generate a high-converting, click-optimized "suggestedTitle" following Backlinko & Google SERP best practices (front-loaded keyword, numbers, power words, under 60 characters).
4. Identify the specific "seoIssue" and describe the concrete "suggestedFix".

### CRITICAL OUTPUT FORMAT:
You MUST respond ONLY with a strict JSON array of objects. Do NOT use markdown code blocks, backticks, or any accompanying conversational text. Format:
[
  {
    "postId": 12345,
    "currentTitle": "Current Title of Article",
    "postLink": "https://brightcelebrity.com/article-slug/",
    "seoIssue": "Precise reason for underperformance (e.g. Title lacks target year and power word, missing search intent hook)",
    "suggestedTitle": "High-converting new headline with numbers and power word",
    "suggestedFix": "Detailed recommended action (e.g., Update post H1/title to target high-CTR query, add FAQ schema for key entities, improve meta description)"
  }
]`;

  const fallbackModels = [
    'gemini-3-flash-preview',
    'gemini-3.5-flash',
    'gemini-flash-latest',
    'gemini-2.0-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-2.5-pro'
  ];

  let rawOutput = '';
  for (const modelName of fallbackModels) {
    try {
      console.log(`  ↳ Requesting analysis from model '${modelName}'...`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      rawOutput = result.response.text();
      if (rawOutput && rawOutput.trim()) {
        break;
      }
    } catch (err) {
      console.warn(`  ↳ Model '${modelName}' failed: ${err.message}. Trying next fallback...`);
    }
  }

  if (!rawOutput) {
    throw new Error('All Gemini fallback models failed to generate response.');
  }

  // Sanitize and extract JSON
  let cleaned = rawOutput.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.replace(/^```json\s*/i, '');
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\s*/i, '');
  if (cleaned.endsWith('```')) cleaned = cleaned.replace(/\s*```$/i, '');
  cleaned = cleaned.trim();

  // Find array brackets if surrounded by extraneous text
  const startIdx = cleaned.indexOf('[');
  const endIdx = cleaned.lastIndexOf(']');
  if (startIdx !== -1 && endIdx !== -1) {
    cleaned = cleaned.substring(startIdx, endIdx + 1);
  }

  const parsed = JSON.parse(cleaned);
  console.log(`  ↳ Successfully generated ${parsed.length} SEO recommendations.`);
  return parsed;
}

/**
 * Escapes HTML characters for Telegram HTML parse_mode.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Sends formatted SEO Audit report to Telegram with inline action button.
 */
async function sendTelegramNotification(auditResults) {
  console.log('[Step 4/4] Sending Telegram notification...');
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('  ↳ Skipping Telegram notification: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing.');
    return;
  }

  const totalItems = auditResults.length;
  let messageLines = [
    `🚨 <b>AI SEO Audit Report (Phase 1)</b> 🚨`,
    `Analyzed <b>${totalItems}</b> recent articles against Google Search Console data.\n`,
    `<b>Critical Issues & Fixes:</b>`
  ];

  auditResults.slice(0, 5).forEach((item, idx) => {
    const title = escapeHtml(item.currentTitle || `Post #${item.postId}`);
    const issue = escapeHtml(item.seoIssue || 'Needs optimization');
    const suggested = escapeHtml(item.suggestedTitle || 'N/A');
    const link = item.postLink || '#';

    messageLines.push(
      `\n${idx + 1}. <a href="${link}"><b>${title}</b></a>\n` +
      `   ⚠️ <b>Issue:</b> ${issue}\n` +
      `   💡 <b>Fix Title:</b> <i>${suggested}</i>`
    );
  });

  messageLines.push(`\n⚡ <i>Click below to review and run automated fixes:</i>`);

  const messageText = messageLines.join('\n');
  const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text: messageText,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '🛠 Approve & Run Fixer',
            callback_data: 'trigger_fix'
          }
        ]
      ]
    }
  };

  try {
    const res = await axios.post(telegramUrl, payload, { timeout: 10000 });
    if (res.data && res.data.ok) {
      console.log('  ↳ ✅ Telegram notification sent successfully.');
    } else {
      console.warn('  ↳ [Telegram Warning] API response not ok:', res.data);
    }
  } catch (tgErr) {
    const errData = tgErr.response ? JSON.stringify(tgErr.response.data) : tgErr.message;
    console.error(`  ↳ [Telegram Error] Failed to send message: ${errData}`);
  }
}

/**
 * Main execution flow
 */
async function runAudit() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('       🚀 STARTING AI SEO AUDIT PIPELINE (PHASE 1)      ');
  console.log('═══════════════════════════════════════════════════════');

  try {
    // 1. Fetch Google Search Console data
    const gscData = await fetchGscPerformanceData();

    // 2. Fetch 5 most recent WordPress posts
    const wpPosts = await fetchRecentWordPressPosts();

    if (!wpPosts || wpPosts.length === 0) {
      console.error('[Audit Error] No WordPress posts fetched. Aborting.');
      process.exit(1);
    }

    // 3. Gemini SEO analysis
    const auditResults = await analyzeWithGemini(wpPosts, gscData);

    // 4. Save locally as audit_data.json
    const outputFile = 'audit_data.json';
    const finalPayload = {
      auditTimestamp: new Date().toISOString(),
      siteUrl: WP_URL,
      analyzedPostCount: wpPosts.length,
      gscStatus: gscData.status,
      auditResults
    };

    fs.writeFileSync(outputFile, JSON.stringify(finalPayload, null, 2), 'utf8');
    console.log(`[Audit Complete] ✅ Saved audit data to ${outputFile}`);

    // 5. Telegram notification
    await sendTelegramNotification(auditResults);

    console.log('═══════════════════════════════════════════════════════');
    console.log('       🎉 AI SEO AUDIT PIPELINE COMPLETED SUCCESSFULLY  ');
    console.log('═══════════════════════════════════════════════════════');
  } catch (error) {
    const errorDetails = error.response?.data || error.response?.status || error.message || error;
    console.error('Audit Fatal Error Details:', errorDetails);
    process.exit(1);
  }
}

runAudit();
