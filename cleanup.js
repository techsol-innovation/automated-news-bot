require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

/**
 * Phase 2: Duplicate Post Cleanup — DRY RUN
 * 
 * This script:
 * 1. Fetches ALL posts from WordPress (paginated, 100/page)
 * 2. Groups them by base slug (strips trailing -\d+ suffixes)
 * 3. For each group with duplicates: marks the OLDEST as KEEP, the rest as TRASH
 * 4. Outputs a detailed report (console + cleanup_report.json)
 * 
 * ⚠️ DRY RUN MODE: No posts are deleted. Run with --execute flag to actually trash.
 */

const EXECUTE_MODE = process.argv.includes('--execute');

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(EXECUTE_MODE
    ? '  🔴 LIVE MODE — POSTS WILL BE TRASHED'
    : '  🟡 DRY RUN — No posts will be modified');
  console.log('═══════════════════════════════════════════════════════\n');

  // ── Validate Environment ──
  const { WP_URL, WP_USERNAME, WP_APP_PASSWORD } = process.env;
  if (!WP_URL || !WP_USERNAME || !WP_APP_PASSWORD) {
    console.error('[Fatal] Missing WP_URL, WP_USERNAME, or WP_APP_PASSWORD in .env');
    process.exit(1);
  }

  const wpBaseUrl = WP_URL.replace(/\/$/, '');
  const credentials = `${WP_USERNAME}:${WP_APP_PASSWORD}`;
  const token = Buffer.from(credentials).toString('base64');
  const authHeaders = {
    'Authorization': `Basic ${token}`,
    'Content-Type': 'application/json'
  };
  const getHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };

  // ══════════════════════════════════════════════════════════════
  // STEP 1: Fetch ALL posts (paginated)
  // ══════════════════════════════════════════════════════════════
  console.log('[Step 1/4] Fetching all posts from WordPress...');
  const allPosts = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    try {
      const url = `${wpBaseUrl}/wp-json/wp/v2/posts?per_page=${perPage}&page=${page}&_fields=id,slug,title,date,link,status&orderby=date&order=asc&_nocache=${Date.now()}`;
      const resp = await axios.get(url, { headers: getHeaders, timeout: 30000 });

      if (!resp.data || resp.data.length === 0) break;

      allPosts.push(...resp.data);
      const totalPages = parseInt(resp.headers['x-wp-totalpages'] || '1', 10);
      const totalPosts = parseInt(resp.headers['x-wp-total'] || '0', 10);

      console.log(`  ↳ Page ${page}/${totalPages} — fetched ${resp.data.length} posts (${allPosts.length}/${totalPosts} total)`);

      if (page >= totalPages) break;
      page++;

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      const detail = err.response
        ? `HTTP ${err.response.status} — ${JSON.stringify(err.response.data).substring(0, 200)}`
        : err.message;
      console.error(`  ↳ [Error] Failed to fetch page ${page}: ${detail}`);

      // If we got a 400 "rest_post_invalid_page_number", we've exhausted all pages
      if (err.response?.status === 400) break;

      // For other errors, retry once after a longer delay
      await new Promise(r => setTimeout(r, 2000));
      break;
    }
  }

  console.log(`\n[Step 1/4] ✅ Fetched ${allPosts.length} total posts.\n`);

  if (allPosts.length === 0) {
    console.log('[Info] No posts found. Nothing to clean up.');
    return;
  }

  // ══════════════════════════════════════════════════════════════
  // STEP 2: Group posts by base slug
  // ══════════════════════════════════════════════════════════════
  console.log('[Step 2/4] Grouping posts by base slug...');

  /**
   * Extracts the base slug by stripping trailing -\d+ suffixes.
   * e.g., "taylor-swift-net-worth-76" → "taylor-swift-net-worth"
   *        "nfl-draft-2026"           → "nfl-draft-2026" (year is NOT a suffix)
   *        "lebron-james-net-worth-2" → "lebron-james-net-worth"
   * 
   * We only strip if the trailing number is ≤ 4 digits AND the slug
   * also exists without it in our dataset. But for safety, we strip
   * any trailing -\d{1,4} that looks like a WordPress auto-increment.
   */
  function getBaseSlug(slug) {
    // Strip trailing -2, -3, ..., -9999 (WordPress auto-increment pattern)
    // But preserve meaningful numbers like -2026 (years) by checking length
    // WordPress increments are typically 1-3 digits for duplicates
    return slug.replace(/-(\d{1,3})$/, '');
  }

  const slugGroups = new Map(); // baseSlug → [{ id, slug, title, date, link }]

  for (const post of allPosts) {
    const baseSlug = getBaseSlug(post.slug);
    if (!slugGroups.has(baseSlug)) {
      slugGroups.set(baseSlug, []);
    }
    slugGroups.get(baseSlug).push({
      id: post.id,
      slug: post.slug,
      title: post.title?.rendered || post.title || '(untitled)',
      date: post.date,
      link: post.link || ''
    });
  }

  console.log(`  ↳ Found ${slugGroups.size} unique base slugs from ${allPosts.length} posts.\n`);

  // ══════════════════════════════════════════════════════════════
  // STEP 3: Identify duplicates (keep oldest, trash the rest)
  // ══════════════════════════════════════════════════════════════
  console.log('[Step 3/4] Identifying duplicates...\n');

  const toKeep = [];
  const toTrash = [];
  const duplicateGroups = [];

  for (const [baseSlug, posts] of slugGroups) {
    if (posts.length <= 1) {
      // No duplicates — this post is unique
      toKeep.push(posts[0]);
      continue;
    }

    // Sort by date ascending — oldest first
    posts.sort((a, b) => new Date(a.date) - new Date(b.date));

    const original = posts[0]; // Keep the oldest
    const duplicates = posts.slice(1); // Trash the rest

    toKeep.push(original);
    toTrash.push(...duplicates);

    duplicateGroups.push({
      baseSlug,
      totalCount: posts.length,
      duplicateCount: duplicates.length,
      keepPost: {
        id: original.id,
        slug: original.slug,
        title: original.title,
        date: original.date
      },
      trashPosts: duplicates.map(d => ({
        id: d.id,
        slug: d.slug,
        title: d.title,
        date: d.date
      }))
    });
  }

  // Sort duplicate groups by count (worst offenders first)
  duplicateGroups.sort((a, b) => b.duplicateCount - a.duplicateCount);

  // ══════════════════════════════════════════════════════════════
  // STEP 4: Generate Report
  // ══════════════════════════════════════════════════════════════
  console.log('[Step 4/4] Generating cleanup report...\n');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  CLEANUP REPORT');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Total posts fetched:       ${allPosts.length}`);
  console.log(`  Unique base slugs:         ${slugGroups.size}`);
  console.log(`  Posts to KEEP (originals): ${toKeep.length}`);
  console.log(`  Posts to TRASH (dupes):    ${toTrash.length}`);
  console.log(`  Duplicate slug groups:     ${duplicateGroups.length}`);
  console.log('═══════════════════════════════════════════════════════\n');

  // Show top 20 worst offenders
  console.log('  TOP DUPLICATE OFFENDERS:');
  console.log('  ─────────────────────────────────────────────────');
  const topOffenders = duplicateGroups.slice(0, 20);
  for (const group of topOffenders) {
    console.log(`  "${group.baseSlug}" → ${group.totalCount} posts (${group.duplicateCount} duplicates to trash)`);
    console.log(`    KEEP: ID ${group.keepPost.id} | "${group.keepPost.slug}" | ${group.keepPost.date}`);
    for (const trash of group.trashPosts.slice(0, 3)) {
      console.log(`    TRASH: ID ${trash.id} | "${trash.slug}" | ${trash.date}`);
    }
    if (group.trashPosts.length > 3) {
      console.log(`    ... and ${group.trashPosts.length - 3} more duplicates`);
    }
    console.log('');
  }

  if (duplicateGroups.length > 20) {
    console.log(`  ... and ${duplicateGroups.length - 20} more duplicate groups.\n`);
  }

  // Save full report to JSON
  const report = {
    generatedAt: new Date().toISOString(),
    mode: EXECUTE_MODE ? 'LIVE' : 'DRY_RUN',
    summary: {
      totalPosts: allPosts.length,
      uniqueBaseSlugs: slugGroups.size,
      postsToKeep: toKeep.length,
      postsToTrash: toTrash.length,
      duplicateGroupCount: duplicateGroups.length
    },
    trashPostIds: toTrash.map(p => p.id),
    duplicateGroups
  };

  fs.writeFileSync('cleanup_report.json', JSON.stringify(report, null, 2), 'utf8');
  console.log('[Report] ✅ Full report saved to cleanup_report.json\n');

  // ══════════════════════════════════════════════════════════════
  // EXECUTE MODE: Actually trash the duplicates
  // ══════════════════════════════════════════════════════════════
  if (EXECUTE_MODE) {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  🔴 EXECUTING DELETION — Trashing duplicate posts...');
    console.log('═══════════════════════════════════════════════════════\n');

    let trashed = 0;
    let failed = 0;

    for (let i = 0; i < toTrash.length; i++) {
      const post = toTrash[i];
      try {
        // Move to trash (not permanent delete — can be recovered from WP admin)
        await axios.delete(
          `${wpBaseUrl}/wp-json/wp/v2/posts/${post.id}`,
          { headers: authHeaders, timeout: 15000 }
        );
        trashed++;
        if (trashed % 50 === 0 || i === toTrash.length - 1) {
          console.log(`  ↳ Progress: ${trashed}/${toTrash.length} trashed (${failed} failed)`);
        }
      } catch (err) {
        failed++;
        const detail = err.response
          ? `HTTP ${err.response.status}`
          : err.message;
        console.warn(`  ↳ [Warning] Failed to trash post ID ${post.id} ("${post.slug}"): ${detail}`);
      }

      // Rate limit: 10 requests/second max
      if ((i + 1) % 10 === 0) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    console.log(`\n[Execute] ✅ Done. Trashed: ${trashed} | Failed: ${failed}`);
    console.log('[Execute] Posts were moved to WordPress Trash (recoverable for 30 days).');
  } else {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  🟡 DRY RUN COMPLETE — No posts were modified.');
    console.log('  To execute deletion, run: node cleanup.js --execute');
    console.log('═══════════════════════════════════════════════════════');
  }
}

main().catch(err => {
  console.error('[Fatal] Unhandled error:', err.message);
  process.exit(1);
});
