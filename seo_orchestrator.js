require('dotenv').config();
const fs = require('fs');

/**
 * ═══════════════════════════════════════════════════════════════════════
 * SEO ORCHESTRATOR — David Quaid's Complete AI SEO Automation System
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * Master controller that ties all three operational pillars together:
 * 
 *   PILLAR 1: Topical Authority Framework (topical_authority.js)
 *     → Cluster Strategy, Cornerstone Mapping, Use-Case Pages
 * 
 *   PILLAR 2: Technical Indexing & Visibility Protocols (technical_indexing.js)
 *     → Fresh Start Hack, PageRank Distribution, Title Metadata Cleanup
 * 
 *   PILLAR 3: AI-Automation Content Strategy (ai_content_strategy.js)
 *     → Anti-AI Pattern Filter, Dedicated FAQ Pages, Empirical Testing
 * 
 * Execution Modes:
 *   --full          Run all three pillars (weekly recommended)
 *   --authority     Run only Pillar 1: Topical Authority
 *   --technical     Run only Pillar 2: Technical Indexing
 *   --content       Run only Pillar 3: AI Content Strategy
 *   --quick         Run lightweight checks only (daily recommended)
 */

const { runTopicalAuthority } = require('./topical_authority');
const { runTechnicalIndexing, cleanupTitleMetadata, analyzePageRankDistribution } = require('./technical_indexing');
const { runAIContentStrategy, scanForAIPatterns } = require('./ai_content_strategy');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Parses CLI arguments into execution flags.
 */
function parseArgs() {
  const args = process.argv.slice(2);
  return {
    full: args.includes('--full') || args.length === 0,
    authority: args.includes('--authority'),
    technical: args.includes('--technical'),
    content: args.includes('--content'),
    quick: args.includes('--quick')
  };
}

/**
 * Quick daily health check — runs lightweight diagnostics without 
 * heavy Gemini calls or content generation.
 */
async function runQuickHealthCheck() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('   ⚡ QUICK DAILY SEO HEALTH CHECK                     ');
  console.log('═══════════════════════════════════════════════════════\n');

  const results = {
    timestamp: new Date().toISOString(),
    mode: 'quick_health_check'
  };

  // 1. Title metadata cleanup (no Gemini needed)
  console.log('[Quick Check 1/3] Title metadata cleanup...');
  results.titleCleanup = await cleanupTitleMetadata();

  // 2. PageRank distribution analysis (no Gemini needed)
  console.log('\n[Quick Check 2/3] PageRank distribution...');
  results.pageRank = await analyzePageRankDistribution();

  // 3. Quick AI pattern scan on the 5 most recent posts
  console.log('\n[Quick Check 3/3] AI pattern scan on recent posts...');
  const axios = require('axios');
  const WP_URL = (process.env.WP_URL || '').replace(/\/$/, '');

  try {
    const resp = await axios.get(
      `${WP_URL}/wp-json/wp/v2/posts?per_page=5&orderby=date&order=desc&_fields=id,title,content,link&_nocache=${Date.now()}`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000
      }
    );

    const posts = resp.data || [];
    results.aiPatternScans = posts.map(post => {
      const title = (post.title?.rendered || '').replace(/<[^>]+>/g, '').trim();
      const content = post.content?.rendered || '';
      return {
        postId: post.id,
        title,
        link: post.link,
        ...scanForAIPatterns(content, title)
      };
    });
  } catch (err) {
    console.warn(`[Quick Check] AI scan failed: ${err.message}`);
    results.aiPatternScans = [];
  }

  // Save quick report
  fs.writeFileSync('seo_health_check.json', JSON.stringify(results, null, 2), 'utf8');

  // Summary
  const titleIssues = results.titleCleanup?.length || 0;
  const prIssues = results.pageRank?.issues?.length || 0;
  const aiAlerts = results.aiPatternScans?.filter(s => s.severity === 'critical' || s.severity === 'high').length || 0;

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('   📊 QUICK HEALTH CHECK SUMMARY                       ');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`   Title Issues Fixed:     ${titleIssues}`);
  console.log(`   PageRank Issues:        ${prIssues}`);
  console.log(`   AI Pattern Alerts:      ${aiAlerts}`);
  console.log(`   Overall Health:         ${titleIssues + prIssues + aiAlerts === 0 ? '🟢 HEALTHY' : aiAlerts > 0 ? '🔴 NEEDS ATTENTION' : '🟡 MINOR ISSUES'}`);
  console.log('═══════════════════════════════════════════════════════\n');

  return results;
}

/**
 * Full pipeline execution — runs all three pillars sequentially.
 */
async function runFullPipeline() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║                                                       ║');
  console.log('║   🚀 DAVID QUAID SEO AUTOMATION SYSTEM                ║');
  console.log('║   Full Pipeline Execution                             ║');
  console.log('║                                                       ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  const startTime = Date.now();
  const masterReport = {
    timestamp: new Date().toISOString(),
    mode: 'full_pipeline',
    pillars: {}
  };

  try {
    // ═══ PILLAR 1: Topical Authority Framework ═══
    console.log('\n\n▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓');
    console.log('▓  PILLAR 1: TOPICAL AUTHORITY FRAMEWORK               ▓');
    console.log('▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓\n');
    masterReport.pillars.topicalAuthority = await runTopicalAuthority();
    await delay(3000);

    // ═══ PILLAR 2: Technical Indexing ═══
    console.log('\n\n▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓');
    console.log('▓  PILLAR 2: TECHNICAL INDEXING & VISIBILITY           ▓');
    console.log('▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓\n');
    masterReport.pillars.technicalIndexing = await runTechnicalIndexing();
    await delay(3000);

    // ═══ PILLAR 3: AI Content Strategy ═══
    console.log('\n\n▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓');
    console.log('▓  PILLAR 3: AI-AUTOMATION CONTENT STRATEGY            ▓');
    console.log('▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓\n');
    masterReport.pillars.aiContentStrategy = await runAIContentStrategy();

    // Calculate execution time
    const executionTime = ((Date.now() - startTime) / 1000).toFixed(1);
    masterReport.executionTimeSeconds = parseFloat(executionTime);

    // Save master report
    fs.writeFileSync('seo_master_report.json', JSON.stringify(masterReport, null, 2), 'utf8');

    // ═══ MASTER SUMMARY ═══
    const ta = masterReport.pillars.topicalAuthority?.summary || {};
    const ti = masterReport.pillars.technicalIndexing || {};
    const acs = masterReport.pillars.aiContentStrategy || {};

    console.log('\n\n╔═══════════════════════════════════════════════════════╗');
    console.log('║   📊 MASTER SEO PIPELINE SUMMARY                      ║');
    console.log('╠═══════════════════════════════════════════════════════╣');
    console.log('║                                                       ║');
    console.log(`║   ⏱️  Execution Time: ${executionTime}s                        `);
    console.log('║                                                       ║');
    console.log('║   PILLAR 1 — Topical Authority:                       ║');
    console.log(`║     Clusters Found:          ${ta.clusters_found || 0}                       `);
    console.log(`║     Orphan Articles:         ${ta.orphan_articles || 0}                       `);
    console.log(`║     Cornerstone Pages:       ${ta.cornerstone_pages_ready || 0}                       `);
    console.log(`║     Use-Case Pages:          ${ta.use_case_pages_ready || 0}                       `);
    console.log(`║     Internal Link Actions:   ${ta.internal_links_suggested || 0}                       `);
    console.log('║                                                       ║');
    console.log('║   PILLAR 2 — Technical Indexing:                      ║');
    console.log(`║     Fresh Start Candidates:  ${ti.freshStart?.candidates?.length || 0}                       `);
    console.log(`║     Fresh Starts Executed:    ${ti.freshStart?.executed?.length || 0}                       `);
    console.log(`║     Title Issues Fixed:       ${ti.titleCleanup?.length || 0}                       `);
    console.log(`║     PageRank Issues:          ${ti.pageRankAnalysis?.issues?.length || 0}                       `);
    console.log('║                                                       ║');
    console.log('║   PILLAR 3 — AI Content Strategy:                     ║');
    console.log(`║     Posts AI-Scanned:         ${acs.antiAIAudit?.length || 0}                       `);
    console.log(`║     AI Pattern Alerts:        ${acs.antiAIAudit?.filter(s => s.severity === 'critical' || s.severity === 'high').length || 0}                       `);
    console.log(`║     FAQ Pages Generated:      ${acs.faqPages?.length || 0}                       `);
    console.log(`║     Publishing Velocity:      ${acs.empiricalTests?.velocity?.last_week || 0}/week          `);
    console.log('║                                                       ║');
    console.log('╚═══════════════════════════════════════════════════════╝\n');

    return masterReport;
  } catch (error) {
    console.error('\n[FATAL] Master pipeline execution failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

/**
 * Main entry point — dispatches to the correct execution mode.
 */
async function main() {
  const flags = parseArgs();

  if (flags.quick) {
    await runQuickHealthCheck();
  } else if (flags.authority && !flags.full) {
    await runTopicalAuthority();
  } else if (flags.technical && !flags.full) {
    await runTechnicalIndexing();
  } else if (flags.content && !flags.full) {
    await runAIContentStrategy();
  } else {
    await runFullPipeline();
  }
}

main().catch(err => {
  console.error('[FATAL] Unhandled error in SEO Orchestrator:', err.message);
  process.exit(1);
});
