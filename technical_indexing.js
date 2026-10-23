require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── Configuration ──
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
const WP_URL = (process.env.WP_URL || '').replace(/\/$/, '');
const GSC_CREDENTIALS = process.env.GSC_CREDENTIALS;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * ═══════════════════════════════════════════════════════════════════
 * PILLAR 2: TECHNICAL INDEXING & VISIBILITY PROTOCOLS
 * ═══════════════════════════════════════════════════════════════════
 * 
 * David Quaid's core technical SEO strategies:
 * 
 *   1. "Fresh Start" Hack (14:29-15:28, 27:06-28:18):
 *      If a high-quality page is stuck as "Crawled, not indexed,"
 *      take it down and republish with a new URL/slug to reset crawl priority.
 * 
 *   2. PageRank Fundamentals (05:47-06:37, 24:40-25:26):
 *      Even in 2025+, PageRank is a primary driver. Prioritize earning
 *      links from high-authority sources and efficient internal linking.
 * 
 *   3. Simplified Title Metadata (135:37-139:46):
 *      Strictly remove brand names from page_title tags. Use the dedicated
 *      "Site Name" setting in Search Console to keep titles 100% relevant.
 */

// ── WordPress API Helper ──
function getWpHeaders(auth = false) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json'
  };
  if (auth && process.env.WP_USERNAME && process.env.WP_APP_PASSWORD) {
    const creds = `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`;
    headers['Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`;
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/**
 * Parses Google Service Account credentials safely.
 */
function getGscCredentials() {
  if (!GSC_CREDENTIALS) return null;
  try {
    return JSON.parse(GSC_CREDENTIALS);
  } catch (err) {
    console.warn('[Technical Indexing] Failed to parse GSC_CREDENTIALS:', err.message);
    return null;
  }
}

/**
 * ══════════════════════════════════════════════════════════
 * PROTOCOL 1: THE "FRESH START" HACK (14:29-15:28, 27:06-28:18)
 * ══════════════════════════════════════════════════════════
 * 
 * Detects posts stuck in "Crawled, not indexed" limbo by:
 *   1. Fetching Google Search Console URL Inspection data
 *   2. Identifying posts with 0 impressions over 14+ days
 *   3. Republishing them with new optimized slugs
 *   4. Submitting the new URLs for indexing
 */

/**
 * Fetches posts with zero search impressions (stale/deindexed candidates).
 * Uses GSC search analytics to find pages that appear in our WP but get
 * zero impressions — indicating they're likely stuck or not indexed.
 */
async function detectStalePages() {
  console.log('[Fresh Start Hack] Detecting pages stuck in indexing limbo...');

  const credentials = getGscCredentials();
  if (!credentials) {
    console.warn('[Fresh Start Hack] Skipping: GSC credentials not available.');
    return [];
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/webmasters', 'https://www.googleapis.com/auth/webmasters.readonly']
    });

    const searchconsole = google.searchconsole({ version: 'v1', auth });

    // Get site URL
    const parsedUrl = new URL(WP_URL || 'https://brightcelebrity.com');
    let siteUrl = `${parsedUrl.protocol}//${parsedUrl.host}/`;

    try {
      const sitesList = await searchconsole.sites.list();
      const entries = sitesList.data.siteEntry || [];
      const matched = entries.find(e => e.siteUrl.includes(parsedUrl.host));
      if (matched) siteUrl = matched.siteUrl;
      else if (entries.length > 0) siteUrl = entries[0].siteUrl;
    } catch (e) { /* Use fallback */ }

    // Query last 14 days — find pages with impressions but very low/zero clicks
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 2);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 16);

    const response = await searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
        dimensions: ['page'],
        rowLimit: 500
      }
    });

    const rows = response.data.rows || [];
    const gscPageSet = new Set(rows.map(r => r.keys[0]));
    const lowPerformers = rows.filter(r => r.impressions < 5 && r.clicks === 0);

    console.log(`[Fresh Start Hack] GSC returned ${rows.length} pages. Found ${lowPerformers.length} with near-zero visibility.`);

    // Now fetch all WP posts and find ones NOT in GSC at all (truly stuck)
    const wpResp = await axios.get(
      `${WP_URL}/wp-json/wp/v2/posts?per_page=100&_fields=id,title,slug,link,date,status&_nocache=${Date.now()}`,
      { headers: getWpHeaders(), timeout: 15000 }
    );

    const wpPosts = wpResp.data || [];
    const stalePages = [];

    for (const post of wpPosts) {
      const postUrl = post.link;
      const rawTitle = post.title?.rendered || post.title || '';
      const cleanTitle = rawTitle.replace(/&#\d+;/g, '').replace(/&amp;/g, '&').trim();

      // Check if post URL exists in GSC data
      const inGsc = gscPageSet.has(postUrl);
      const isLowPerformer = lowPerformers.some(lp => lp.keys[0] === postUrl);

      // Post age check — only flag posts older than 14 days
      const postAge = (Date.now() - new Date(post.date).getTime()) / (1000 * 60 * 60 * 24);

      if (postAge >= 14 && (!inGsc || isLowPerformer)) {
        stalePages.push({
          postId: post.id,
          title: cleanTitle,
          slug: post.slug,
          link: postUrl,
          age_days: Math.round(postAge),
          gsc_status: inGsc ? 'low_performer' : 'not_in_gsc',
          impressions: isLowPerformer ? lowPerformers.find(lp => lp.keys[0] === postUrl)?.impressions || 0 : 0,
          action: 'fresh_start_candidate'
        });
      }
    }

    console.log(`[Fresh Start Hack] ✅ Identified ${stalePages.length} fresh start candidates.`);
    return stalePages;
  } catch (error) {
    console.error(`[Fresh Start Hack] Detection failed: ${error.message}`);
    return [];
  }
}

/**
 * Executes the "Fresh Start" on a stale page:
 *   1. Generates a new optimized slug via Gemini
 *   2. Updates the WordPress post with the new slug
 *   3. Pings IndexNow with the new URL
 *   4. Submits the new URL to Google Indexing API
 * 
 * @param {Object} stalePage - A stale page object from detectStalePages()
 * @returns {Promise<Object>} Result of the fresh start operation
 */
async function executeFreshStart(stalePage) {
  console.log(`[Fresh Start] Executing on: "${stalePage.title}" (age: ${stalePage.age_days}d, status: ${stalePage.gsc_status})`);

  try {
    // Step 1: Generate new optimized slug via Gemini
    const slugPrompt = `Generate a NEW, optimized URL slug for this article. The current slug "${stalePage.slug}" is stuck in Google's indexing limbo.

Title: "${stalePage.title}"

RULES:
- Keep it SHORT (3-5 words max, hyphenated)
- Must be keyword-focused and match search intent
- Must be DIFFERENT from the current slug: "${stalePage.slug}"
- No dates, no numbers unless essential to the topic
- Lowercase, hyphen-separated

Return ONLY the new slug as a plain string. No quotes, no JSON, no explanation.
Example: lebron-james-net-worth`;

    const result = await geminiModel.generateContent(slugPrompt);
    let newSlug = result.response.text().trim().toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/(^-|-$)+/g, '')
      .replace(/-{2,}/g, '-');

    // Ensure it's different from the original
    if (newSlug === stalePage.slug) {
      newSlug = `${stalePage.slug}-updated`;
    }

    // Step 2: Update WordPress post with new slug
    const updatePayload = { slug: newSlug };
    await axios.post(
      `${WP_URL}/wp-json/wp/v2/posts/${stalePage.postId}`,
      updatePayload,
      { headers: getWpHeaders(true), timeout: 15000 }
    );

    const newUrl = `${WP_URL}/${newSlug}/`;
    console.log(`  ↳ ✅ Updated slug: "${stalePage.slug}" → "${newSlug}"`);

    // Step 3: Ping IndexNow for the new URL
    try {
      const siteHost = new URL(WP_URL).host;
      await axios.get(
        `https://api.indexnow.org/IndexNow?url=${encodeURIComponent(newUrl)}&key=autopublisher&keyLocation=https://${siteHost}/autopublisher.txt`,
        { timeout: 10000 }
      );
      console.log(`  ↳ ✅ IndexNow pinged for new URL.`);
    } catch (e) {
      console.warn(`  ↳ ⚠️ IndexNow ping failed: ${e.message}`);
    }

    // Step 4: Submit to Google Indexing API (if credentials available)
    const credentials = getGscCredentials();
    if (credentials) {
      try {
        const auth = new google.auth.GoogleAuth({
          credentials,
          scopes: ['https://www.googleapis.com/auth/indexing']
        });
        const indexing = google.indexing({ version: 'v3', auth });

        // Notify removal of old URL
        await indexing.urlNotifications.publish({
          requestBody: { url: stalePage.link, type: 'URL_DELETED' }
        });
        console.log(`  ↳ ✅ Submitted URL_DELETED for old URL.`);

        // Notify new URL
        await indexing.urlNotifications.publish({
          requestBody: { url: newUrl, type: 'URL_UPDATED' }
        });
        console.log(`  ↳ ✅ Submitted URL_UPDATED for new URL.`);
      } catch (idxErr) {
        console.warn(`  ↳ ⚠️ Google Indexing API notification failed: ${idxErr.message}`);
      }
    }

    return {
      postId: stalePage.postId,
      title: stalePage.title,
      oldSlug: stalePage.slug,
      newSlug,
      oldUrl: stalePage.link,
      newUrl,
      status: 'fresh_start_executed'
    };
  } catch (error) {
    console.error(`[Fresh Start] Failed for "${stalePage.title}": ${error.message}`);
    return {
      postId: stalePage.postId,
      title: stalePage.title,
      status: 'failed',
      error: error.message
    };
  }
}

/**
 * ══════════════════════════════════════════════════════════
 * PROTOCOL 2: TITLE METADATA CLEANUP (135:37 - 139:46)
 * ══════════════════════════════════════════════════════════
 * 
 * David Quaid's rule: Strictly remove brand names from page_title tags.
 * Use the "Site Name" setting in Search Console instead. Title must be
 * 100% relevant to the target keyword — no wasted characters on branding.
 */
async function cleanupTitleMetadata() {
  console.log('[Title Cleanup] Scanning posts for brand-polluted title tags...');

  try {
    const wpResp = await axios.get(
      `${WP_URL}/wp-json/wp/v2/posts?per_page=50&_fields=id,title,slug,link,meta&_nocache=${Date.now()}`,
      { headers: getWpHeaders(true), timeout: 15000 }
    );

    const posts = wpResp.data || [];
    const brandPatterns = [
      /\s*[-–—|]\s*BrightCelebrity\s*/gi,
      /\s*[-–—|]\s*Bright\s*Celebrity\s*/gi,
      /\s*[-–—|]\s*CraftZone\s*/gi,
      /\s*[-–—|]\s*Craft\s*Zone\s*/gi,
      /\s*BrightCelebrity\s*[-–—|]\s*/gi,
      /\s*CraftZone\s*[-–—|]\s*/gi
    ];

    const fixes = [];

    for (const post of posts) {
      const rawTitle = post.title?.rendered || '';
      const cleanTitle = rawTitle.replace(/&#\d+;/g, '').replace(/&amp;/g, '&').trim();
      const rankMathTitle = post.meta?.rank_math_title || '';

      let titleNeedsCleanup = false;
      let cleanedTitle = cleanTitle;

      for (const pattern of brandPatterns) {
        if (pattern.test(cleanedTitle)) {
          cleanedTitle = cleanedTitle.replace(pattern, '').trim();
          titleNeedsCleanup = true;
        }
        pattern.lastIndex = 0; // Reset regex state
      }

      // Also check RankMath meta title
      let cleanedRmTitle = rankMathTitle;
      let rmNeedsCleanup = false;
      for (const pattern of brandPatterns) {
        if (pattern.test(cleanedRmTitle)) {
          cleanedRmTitle = cleanedRmTitle.replace(pattern, '').trim();
          rmNeedsCleanup = true;
        }
        pattern.lastIndex = 0;
      }

      // Check title length — flag titles over 60 chars
      const isTooLong = cleanedTitle.length > 60;

      if (titleNeedsCleanup || rmNeedsCleanup || isTooLong) {
        fixes.push({
          postId: post.id,
          currentTitle: cleanTitle,
          cleanedTitle: cleanedTitle.substring(0, 60),
          rankMathTitle: rankMathTitle,
          cleanedRmTitle: cleanedRmTitle.substring(0, 60),
          issues: [
            ...(titleNeedsCleanup ? ['brand_in_title'] : []),
            ...(rmNeedsCleanup ? ['brand_in_meta_title'] : []),
            ...(isTooLong ? ['title_over_60_chars'] : [])
          ],
          link: post.link
        });
      }
    }

    console.log(`[Title Cleanup] Scanned ${posts.length} posts. Found ${fixes.length} with title metadata issues.`);

    // Apply fixes
    let fixedCount = 0;
    for (const fix of fixes) {
      try {
        const payload = {
          title: fix.cleanedTitle,
          meta: {
            rank_math_title: fix.cleanedRmTitle || fix.cleanedTitle
          }
        };

        await axios.post(
          `${WP_URL}/wp-json/wp/v2/posts/${fix.postId}`,
          payload,
          { headers: getWpHeaders(true), timeout: 15000 }
        );

        console.log(`  ↳ ✅ Fixed [${fix.issues.join(', ')}]: "${fix.currentTitle}" → "${fix.cleanedTitle}"`);
        fixedCount++;
      } catch (err) {
        console.error(`  ↳ ❌ Failed to fix post ${fix.postId}: ${err.message}`);
      }
    }

    console.log(`[Title Cleanup] ✅ Fixed ${fixedCount}/${fixes.length} title metadata issues.`);
    return fixes;
  } catch (error) {
    console.error(`[Title Cleanup] Failed: ${error.message}`);
    return [];
  }
}

/**
 * ══════════════════════════════════════════════════════════
 * PROTOCOL 3: PAGERANK DISTRIBUTION ANALYSIS (05:47-06:37)
 * ══════════════════════════════════════════════════════════
 * 
 * Analyzes internal link equity distribution and identifies
 * pages that need more internal links pointing to them.
 */
async function analyzePageRankDistribution() {
  console.log('[PageRank Analysis] Analyzing internal link equity distribution...');

  try {
    // Fetch posts with full content to analyze internal links
    const wpResp = await axios.get(
      `${WP_URL}/wp-json/wp/v2/posts?per_page=100&_fields=id,title,slug,link,content&_nocache=${Date.now()}`,
      { headers: getWpHeaders(), timeout: 20000 }
    );

    const posts = wpResp.data || [];
    const siteHost = new URL(WP_URL).host;

    // Build link graph
    const linkGraph = new Map(); // postId -> { inbound: Set, outbound: Set }

    for (const post of posts) {
      const content = post.content?.rendered || '';
      const postUrl = post.link;

      if (!linkGraph.has(post.id)) {
        linkGraph.set(post.id, { inbound: new Set(), outbound: new Set(), title: post.title?.rendered || post.slug, link: postUrl });
      }

      // Find all internal links in the content
      const linkRegex = /href=["'](https?:\/\/[^"']*?)["']/gi;
      let match;
      while ((match = linkRegex.exec(content)) !== null) {
        const linkedUrl = match[1];
        try {
          const linkedHost = new URL(linkedUrl).host;
          if (linkedHost === siteHost) {
            // Find the target post
            const targetPost = posts.find(p => p.link === linkedUrl || linkedUrl.includes(p.slug));
            if (targetPost && targetPost.id !== post.id) {
              linkGraph.get(post.id).outbound.add(targetPost.id);
              
              if (!linkGraph.has(targetPost.id)) {
                linkGraph.set(targetPost.id, { inbound: new Set(), outbound: new Set(), title: targetPost.title?.rendered || targetPost.slug, link: targetPost.link });
              }
              linkGraph.get(targetPost.id).inbound.add(post.id);
            }
          }
        } catch (e) { /* Invalid URL */ }
      }
    }

    // Identify PageRank issues
    const prIssues = [];
    for (const [postId, data] of linkGraph) {
      const inboundCount = data.inbound.size;
      const outboundCount = data.outbound.size;

      if (inboundCount === 0) {
        prIssues.push({
          postId,
          title: data.title?.replace(/<[^>]+>/g, '').trim() || `Post #${postId}`,
          link: data.link,
          issue: 'zero_inbound_links',
          severity: 'critical',
          inbound: inboundCount,
          outbound: outboundCount,
          suggestion: 'This page receives no internal link equity. Add links from related articles.'
        });
      } else if (inboundCount === 1) {
        prIssues.push({
          postId,
          title: data.title?.replace(/<[^>]+>/g, '').trim() || `Post #${postId}`,
          link: data.link,
          issue: 'low_inbound_links',
          severity: 'warning',
          inbound: inboundCount,
          outbound: outboundCount,
          suggestion: 'This page has minimal internal link equity. Add 2-3 more internal links from related content.'
        });
      }

      if (outboundCount === 0) {
        prIssues.push({
          postId,
          title: data.title?.replace(/<[^>]+>/g, '').trim() || `Post #${postId}`,
          link: data.link,
          issue: 'zero_outbound_links',
          severity: 'warning',
          inbound: inboundCount,
          outbound: outboundCount,
          suggestion: 'This page distributes no equity. Add contextual links to related articles.'
        });
      }
    }

    console.log(`[PageRank Analysis] ✅ Analyzed ${posts.length} posts. Found ${prIssues.length} PageRank distribution issues.`);
    return {
      totalPosts: posts.length,
      issues: prIssues,
      summary: {
        zero_inbound: prIssues.filter(i => i.issue === 'zero_inbound_links').length,
        low_inbound: prIssues.filter(i => i.issue === 'low_inbound_links').length,
        zero_outbound: prIssues.filter(i => i.issue === 'zero_outbound_links').length
      }
    };
  } catch (error) {
    console.error(`[PageRank Analysis] Failed: ${error.message}`);
    return { totalPosts: 0, issues: [], summary: {} };
  }
}

/**
 * ══════════════════════════════════════════════════════════════
 * MASTER EXECUTION: Run the complete Technical Indexing pipeline
 * ══════════════════════════════════════════════════════════════
 */
async function runTechnicalIndexing() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('   🔧 TECHNICAL INDEXING & VISIBILITY PROTOCOLS        ');
  console.log('═══════════════════════════════════════════════════════');

  const results = {
    timestamp: new Date().toISOString(),
    freshStart: { candidates: [], executed: [] },
    titleCleanup: [],
    pageRankAnalysis: {}
  };

  try {
    // Protocol 1: Fresh Start Hack — Detect and fix stuck pages
    const stalePages = await detectStalePages();
    results.freshStart.candidates = stalePages;

    // Only execute fresh start on the top 5 most stale pages to avoid disruption
    const topCandidates = stalePages
      .sort((a, b) => b.age_days - a.age_days)
      .slice(0, 5);

    for (const stalePage of topCandidates) {
      const freshResult = await executeFreshStart(stalePage);
      results.freshStart.executed.push(freshResult);
      await delay(2000); // Rate limiting
    }

    // Protocol 2: Title Metadata Cleanup
    results.titleCleanup = await cleanupTitleMetadata();

    // Protocol 3: PageRank Distribution Analysis
    results.pageRankAnalysis = await analyzePageRankDistribution();

    // Save report
    fs.writeFileSync('technical_indexing_report.json', JSON.stringify(results, null, 2), 'utf8');
    console.log('\n[Technical Indexing] ✅ Report saved to technical_indexing_report.json');

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('   📊 TECHNICAL INDEXING SUMMARY                       ');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`   Stale Pages Detected:     ${results.freshStart.candidates.length}`);
    console.log(`   Fresh Starts Executed:     ${results.freshStart.executed.length}`);
    console.log(`   Title Issues Fixed:        ${results.titleCleanup.length}`);
    console.log(`   PageRank Issues Found:     ${results.pageRankAnalysis.issues?.length || 0}`);
    console.log(`     → Zero Inbound Links:    ${results.pageRankAnalysis.summary?.zero_inbound || 0}`);
    console.log(`     → Low Inbound Links:     ${results.pageRankAnalysis.summary?.low_inbound || 0}`);
    console.log(`     → Zero Outbound Links:   ${results.pageRankAnalysis.summary?.zero_outbound || 0}`);
    console.log('═══════════════════════════════════════════════════════\n');

    return results;
  } catch (error) {
    console.error(`[Technical Indexing Fatal Error] ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

// Export for orchestrator
module.exports = { runTechnicalIndexing, detectStalePages, executeFreshStart, cleanupTitleMetadata, analyzePageRankDistribution };

// Direct execution
if (require.main === module) {
  runTechnicalIndexing();
}
