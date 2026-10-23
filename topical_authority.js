require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── Configuration ──
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
const WP_URL = (process.env.WP_URL || '').replace(/\/$/, '');
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * ═══════════════════════════════════════════════════════════════════
 * PILLAR 1: TOPICAL AUTHORITY FRAMEWORK (David Quaid 07:09-10:20)
 * ═══════════════════════════════════════════════════════════════════
 * 
 * Core Philosophy: Don't publish isolated articles. Build interconnected
 * content clusters around specific themes to signal expertise to Google.
 * 
 * Three sub-systems:
 *   1. Cluster Strategy — Deep, interconnected content clusters
 *   2. Cornerstone Mapping — Hub pages linking out to sub-topics
 *   3. Granular Use-Case Mapping — Individual pages per user query
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
 * Fetches ALL published posts from WordPress (paginated) to build the content graph.
 * @returns {Promise<Array>} Array of { id, title, slug, link, categories, tags, date, content_snippet }
 */
async function fetchAllPublishedPosts() {
  console.log('[Topical Authority] Fetching all published posts for cluster analysis...');
  const allPosts = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    try {
      const resp = await axios.get(
        `${WP_URL}/wp-json/wp/v2/posts?per_page=${perPage}&page=${page}&_fields=id,title,slug,link,categories,tags,date,content&status=publish&_nocache=${Date.now()}`,
        { headers: getWpHeaders(), timeout: 20000 }
      );

      const posts = resp.data || [];
      if (posts.length === 0) break;

      for (const p of posts) {
        const rawTitle = p.title?.rendered || p.title || '';
        // Strip HTML entities
        const cleanTitle = rawTitle
          .replace(/&#038;/g, '&').replace(/&amp;/g, '&')
          .replace(/&#8217;/g, "'").replace(/&#8216;/g, "'")
          .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"')
          .trim();

        // Extract first 200 chars of content for topic analysis
        const rawContent = p.content?.rendered || '';
        const contentText = rawContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

        allPosts.push({
          id: p.id,
          title: cleanTitle,
          slug: p.slug,
          link: p.link,
          categories: p.categories || [],
          tags: p.tags || [],
          date: p.date,
          content_snippet: contentText
        });
      }

      // Check if there are more pages
      const totalPages = parseInt(resp.headers['x-wp-totalpages'] || '1', 10);
      if (page >= totalPages) break;
      page++;
      await delay(500); // Rate limiting
    } catch (err) {
      if (err.response?.status === 400) break; // No more pages
      console.warn(`[Topical Authority] Pagination error on page ${page}: ${err.message}`);
      break;
    }
  }

  console.log(`[Topical Authority] ✅ Fetched ${allPosts.length} total published posts.`);
  return allPosts;
}

/**
 * ══════════════════════════════════════════════════
 * SUB-SYSTEM 1: CLUSTER STRATEGY (07:09 - 07:46)
 * ══════════════════════════════════════════════════
 * 
 * Uses Gemini to analyze all existing content and identify:
 *   - Existing content clusters (themes with 3+ articles)
 *   - Orphan articles (not part of any cluster)
 *   - Cluster gaps (themes with insufficient depth)
 *   - New cluster opportunities based on trending topics
 */
async function analyzeContentClusters(allPosts) {
  console.log('[Cluster Strategy] Analyzing existing content clusters...');

  if (allPosts.length === 0) {
    return { clusters: [], orphans: [], gaps: [], opportunities: [] };
  }

  const postsDigest = allPosts.map(p => `[${p.id}] "${p.title}" (slug: ${p.slug}, cats: ${p.categories.join(',')})`).join('\n');

  const prompt = `You are an elite SEO Content Strategist specializing in topical authority.

Analyze these ${allPosts.length} published articles and identify CONTENT CLUSTERS — groups of articles that cover the same theme/entity/topic:

${postsDigest}

TASK:
1. Identify existing clusters (groups of 2+ articles about the same person, event series, or theme).
2. Identify orphan articles that don't belong to any cluster.
3. Identify cluster gaps — clusters that exist but need MORE supporting articles to build authority.
4. Suggest 3-5 NEW cluster opportunities based on trending US sports/entertainment themes.

For each cluster gap, suggest 2-3 specific article titles that would complete the cluster.

OUTPUT: Return ONLY valid JSON (no markdown, no backticks):
{
  "clusters": [
    {
      "theme": "Cluster Theme Name",
      "article_ids": [1, 2, 3],
      "depth_score": 7,
      "status": "strong|needs_more|weak"
    }
  ],
  "orphans": [
    { "article_id": 123, "title": "Title", "suggested_cluster": "Potential cluster name" }
  ],
  "gaps": [
    {
      "cluster_theme": "Theme",
      "current_count": 2,
      "needed_articles": [
        "Suggested Article Title 1",
        "Suggested Article Title 2"
      ]
    }
  ],
  "opportunities": [
    {
      "theme": "New Cluster Theme",
      "cornerstone_title": "Main Hub Article Title",
      "supporting_articles": ["Sub-article 1", "Sub-article 2", "Sub-article 3"],
      "estimated_monthly_searches": "10K-50K"
    }
  ]
}`;

  try {
    const result = await geminiModel.generateContent(prompt);
    let text = result.response.text().trim();
    // Clean JSON
    text = text.replace(/```json/gi, '').replace(/```/gi, '').trim();
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      text = text.slice(firstBrace, lastBrace + 1);
    }
    const analysis = JSON.parse(text);
    console.log(`[Cluster Strategy] ✅ Identified ${analysis.clusters?.length || 0} clusters, ${analysis.orphans?.length || 0} orphans, ${analysis.gaps?.length || 0} gaps, ${analysis.opportunities?.length || 0} opportunities.`);
    return analysis;
  } catch (err) {
    console.error(`[Cluster Strategy] Gemini analysis failed: ${err.message}`);
    return { clusters: [], orphans: [], gaps: [], opportunities: [] };
  }
}

/**
 * ══════════════════════════════════════════════════
 * SUB-SYSTEM 2: CORNERSTONE MAPPING (09:31 - 09:41)
 * ══════════════════════════════════════════════════
 * 
 * Creates "cornerstone" hub pages that act as central authority pages,
 * linking out to all related sub-topic articles. This distributes PageRank
 * and signals topical depth to Google.
 */
async function generateCornerstoneContent(clusterAnalysis) {
  console.log('[Cornerstone Mapping] Generating cornerstone hub page content...');

  const opportunities = clusterAnalysis.opportunities || [];
  const gaps = clusterAnalysis.gaps || [];

  if (opportunities.length === 0 && gaps.length === 0) {
    console.log('[Cornerstone Mapping] No cornerstone opportunities identified. Skipping.');
    return [];
  }

  const cornerstones = [];

  // Process top 2 opportunities as cornerstone candidates
  for (const opp of opportunities.slice(0, 2)) {
    const prompt = `You are a Senior SEO Content Architect. Create a CORNERSTONE HUB PAGE for the topic: "${opp.theme}"

This page is the central authority page that will link to these supporting articles:
${(opp.supporting_articles || []).map((a, i) => `${i + 1}. ${a}`).join('\n')}

CORNERSTONE PAGE RULES (David Quaid Strategy):
- This is a comprehensive, authoritative overview page (2500+ words)
- It MUST include a Table of Contents linking to each sub-section
- Each section should naturally link to a supporting article with descriptive anchor text
- Include internal links to https://brightcelebrity.com/ sub-pages
- Use structured FAQ schema at the bottom
- Front-load the primary keyword in the first 50 words
- Include at least one data table and one bulleted list
- NO brand name in the page_title tag (David Quaid 135:37)
- Title must be under 60 characters

OUTPUT: Return ONLY valid JSON:
{
  "title": "SEO-optimized cornerstone title under 60 chars",
  "slug": "keyword-focused-slug",
  "content": "Full HTML content with internal links, schema markup, TOC...",
  "focus_keyword": "primary 2-4 word keyword",
  "seo_description": "120-160 char meta description",
  "supporting_topics": ["Topic 1", "Topic 2"],
  "category": "Parent Category"
}`;

    try {
      const result = await geminiModel.generateContent(prompt);
      let text = result.response.text().trim();
      text = text.replace(/```json/gi, '').replace(/```/gi, '').trim();
      const firstBrace = text.indexOf('{');
      const lastBrace = text.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        text = text.slice(firstBrace, lastBrace + 1);
      }
      // Replace literal \n with spaces for JSON parsing
      text = text.replace(/[\n\r\t]/g, ' ');
      const cornerstone = JSON.parse(text);
      cornerstone.type = 'cornerstone';
      cornerstones.push(cornerstone);
      console.log(`[Cornerstone Mapping] ✅ Generated cornerstone: "${cornerstone.title}"`);
    } catch (err) {
      console.warn(`[Cornerstone Mapping] Failed to generate cornerstone for "${opp.theme}": ${err.message}`);
    }

    await delay(2000); // Rate limiting between Gemini calls
  }

  return cornerstones;
}

/**
 * ══════════════════════════════════════════════════════════════
 * SUB-SYSTEM 3: GRANULAR USE-CASE MAPPING (09:46 - 10:20)
 * ══════════════════════════════════════════════════════════════
 * 
 * David Quaid's key insight: For every product/service/person,
 * create INDIVIDUAL pages for every possible user query/use-case
 * rather than stuffing all info into one generic page.
 * 
 * Example: Instead of one "LeBron James" page, create:
 *   - "LeBron James Net Worth 2026"
 *   - "LeBron James Contract Details"
 *   - "LeBron James Car Collection"
 *   - "LeBron James Real Estate Portfolio"
 *   - "LeBron James Endorsement Deals"
 */
async function generateUseCasePages(clusterAnalysis, allPosts) {
  console.log('[Use-Case Mapping] Identifying granular use-case page opportunities...');

  // Find entities (people) that only have 1-2 articles but high search potential
  const clusters = clusterAnalysis.clusters || [];
  const entityClusters = clusters.filter(c => c.status === 'needs_more' || c.status === 'weak');

  if (entityClusters.length === 0) {
    console.log('[Use-Case Mapping] No thin entity clusters found. Checking opportunities...');
    // Fall back to generating use-case pages from opportunities
    const opps = clusterAnalysis.opportunities || [];
    if (opps.length === 0) return [];
  }

  // Select the top 3 entities that need granular expansion
  const targets = entityClusters.slice(0, 3);

  const useCasePages = [];

  for (const target of targets) {
    const existingTitles = target.article_ids
      .map(id => allPosts.find(p => p.id === id))
      .filter(Boolean)
      .map(p => p.title);

    const prompt = `You are a Granular SEO Strategist. The entity/topic "${target.theme}" currently has ${target.article_ids.length} article(s):
${existingTitles.map(t => `- ${t}`).join('\n')}

Generate 3 UNIQUE, granular use-case page ideas that would capture different search intents for this entity. Each page targets a DIFFERENT user query that someone might search.

RULES (David Quaid 09:46-10:20):
- Each page targets ONE specific use-case/query
- Do NOT duplicate existing articles
- Each title must be under 60 chars, front-loaded with the entity name
- Each must target a distinct long-tail keyword
- Focus on high-intent queries: net worth, salary, car collection, house, wife/husband, age, height, etc.

OUTPUT: Return ONLY valid JSON array:
[
  {
    "title": "SEO title under 60 chars",
    "slug": "keyword-slug",
    "focus_keyword": "target long-tail keyword",
    "search_intent": "informational|commercial|navigational",
    "estimated_volume": "1K-10K",
    "parent_entity": "${target.theme}"
  }
]`;

    try {
      const result = await geminiModel.generateContent(prompt);
      let text = result.response.text().trim();
      text = text.replace(/```json/gi, '').replace(/```/gi, '').trim();
      const startIdx = text.indexOf('[');
      const endIdx = text.lastIndexOf(']');
      if (startIdx !== -1 && endIdx !== -1) {
        text = text.substring(startIdx, endIdx + 1);
      }
      const pages = JSON.parse(text);
      useCasePages.push(...pages);
      console.log(`[Use-Case Mapping] ✅ Generated ${pages.length} use-case pages for "${target.theme}"`);
    } catch (err) {
      console.warn(`[Use-Case Mapping] Failed for "${target.theme}": ${err.message}`);
    }

    await delay(2000);
  }

  return useCasePages;
}

/**
 * Injects internal links into existing WordPress posts to build cluster interconnection.
 * This distributes PageRank across the cluster (David Quaid 05:47-06:37).
 * 
 * @param {Array} clusterAnalysis - The cluster analysis results
 * @param {Array} allPosts - All published posts
 */
async function buildInternalLinkWeb(clusterAnalysis, allPosts) {
  console.log('[Internal Linking] Building internal link web across clusters...');

  const clusters = clusterAnalysis.clusters || [];
  const linkSuggestions = [];

  for (const cluster of clusters) {
    if (cluster.article_ids.length < 2) continue;

    const clusterPosts = cluster.article_ids
      .map(id => allPosts.find(p => p.id === id))
      .filter(Boolean);

    // Each post in the cluster should link to at least 2 others in the same cluster
    for (const post of clusterPosts) {
      const otherPosts = clusterPosts.filter(p => p.id !== post.id);
      const linksNeeded = otherPosts.slice(0, 3); // Max 3 internal links per article

      linkSuggestions.push({
        source_id: post.id,
        source_title: post.title,
        source_link: post.link,
        suggested_links: linksNeeded.map(lp => ({
          target_id: lp.id,
          target_title: lp.title,
          target_url: lp.link,
          anchor_text: lp.title.split(':')[0].trim() // Use first part of title as anchor
        })),
        cluster_theme: cluster.theme
      });
    }
  }

  console.log(`[Internal Linking] ✅ Generated ${linkSuggestions.length} internal link suggestions across ${clusters.length} clusters.`);
  return linkSuggestions;
}

/**
 * ══════════════════════════════════════════════════════════════
 * MASTER EXECUTION: Run the complete Topical Authority pipeline
 * ══════════════════════════════════════════════════════════════
 */
async function runTopicalAuthority() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('   🏗️  TOPICAL AUTHORITY FRAMEWORK (David Quaid)       ');
  console.log('═══════════════════════════════════════════════════════');

  try {
    // Phase 1: Fetch all content
    const allPosts = await fetchAllPublishedPosts();

    if (allPosts.length < 3) {
      console.log('[Topical Authority] Too few posts for cluster analysis. Build more content first.');
      return {
        status: 'insufficient_content',
        postCount: allPosts.length,
        clusters: [],
        cornerstones: [],
        useCasePages: [],
        linkSuggestions: []
      };
    }

    // Phase 2: Analyze content clusters
    const clusterAnalysis = await analyzeContentClusters(allPosts);

    // Phase 3: Generate cornerstone hub pages
    const cornerstones = await generateCornerstoneContent(clusterAnalysis);

    // Phase 4: Generate granular use-case pages
    const useCasePages = await generateUseCasePages(clusterAnalysis, allPosts);

    // Phase 5: Build internal link web
    const linkSuggestions = await buildInternalLinkWeb(clusterAnalysis, allPosts);

    // Save comprehensive report
    const report = {
      timestamp: new Date().toISOString(),
      totalPosts: allPosts.length,
      clusterAnalysis,
      cornerstones,
      useCasePages,
      linkSuggestions,
      summary: {
        clusters_found: clusterAnalysis.clusters?.length || 0,
        orphan_articles: clusterAnalysis.orphans?.length || 0,
        gaps_identified: clusterAnalysis.gaps?.length || 0,
        new_opportunities: clusterAnalysis.opportunities?.length || 0,
        cornerstone_pages_ready: cornerstones.length,
        use_case_pages_ready: useCasePages.length,
        internal_links_suggested: linkSuggestions.length
      }
    };

    fs.writeFileSync('topical_authority_report.json', JSON.stringify(report, null, 2), 'utf8');
    console.log('\n[Topical Authority] ✅ Report saved to topical_authority_report.json');

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('   📊 TOPICAL AUTHORITY SUMMARY                        ');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`   Clusters Found:        ${report.summary.clusters_found}`);
    console.log(`   Orphan Articles:       ${report.summary.orphan_articles}`);
    console.log(`   Gaps Identified:       ${report.summary.gaps_identified}`);
    console.log(`   New Opportunities:     ${report.summary.new_opportunities}`);
    console.log(`   Cornerstone Pages:     ${report.summary.cornerstone_pages_ready}`);
    console.log(`   Use-Case Pages Ready:  ${report.summary.use_case_pages_ready}`);
    console.log(`   Internal Link Actions: ${report.summary.internal_links_suggested}`);
    console.log('═══════════════════════════════════════════════════════\n');

    return report;
  } catch (error) {
    console.error(`[Topical Authority Fatal Error] ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

// Export for orchestrator usage
module.exports = { runTopicalAuthority, analyzeContentClusters, generateCornerstoneContent, generateUseCasePages, buildInternalLinkWeb, fetchAllPublishedPosts };

// Direct execution
if (require.main === module) {
  runTopicalAuthority();
}
