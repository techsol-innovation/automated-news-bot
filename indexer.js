const fs = require('fs');
const axios = require('axios');

/**
 * IndexNow-based URL notifier for search engines.
 * 
 * IMPORTANT: The previous implementation used Google's Indexing API (v3),
 * which is strictly restricted to JobPosting and BroadcastEvent schemas.
 * Using it for blog/news posts was flagging the domain as spam.
 * 
 * This version uses:
 *   1. IndexNow API (Bing, Yandex, Seznam, Naver) — free, no schema restriction
 *   2. Google Search Console sitemap ping — signals Google to re-crawl the sitemap
 */

async function runIndexer() {
  const urlFile = 'latest_url.txt';

  if (!fs.existsSync(urlFile)) {
    console.log('[Indexer] No new URLs to index (file latest_url.txt not found). Exiting.');
    return;
  }

  const urlsText = fs.readFileSync(urlFile, 'utf8').trim();
  if (!urlsText) {
    console.log('[Indexer] latest_url.txt is empty. Exiting.');
    return;
  }

  const newUrls = urlsText.split('\n').map(u => u.trim()).filter(Boolean);
  
  if (newUrls.length === 0) {
    console.log('[Indexer] No valid URLs found in latest_url.txt. Exiting.');
    return;
  }

  console.log(`[Indexer] Processing ${newUrls.length} URL(s) via IndexNow...`);

  let successCount = 0;
  let failCount = 0;

  for (const articleUrl of newUrls) {
    console.log(`\n[Indexer] Processing URL: ${articleUrl}`);
    
    try {
      const urlObj = new URL(articleUrl);
      const siteHost = urlObj.host;

      // 1. IndexNow API — notify Bing, Yandex, Seznam, Naver simultaneously
      try {
        const indexNowUrl = `https://api.indexnow.org/IndexNow?url=${encodeURIComponent(articleUrl)}&key=autopublisher&keyLocation=https://${siteHost}/autopublisher.txt`;
        await axios.get(indexNowUrl, { timeout: 10000 });
        console.log(`  ↳ [IndexNow] ✅ Pinged search engines for: ${articleUrl}`);
      } catch (indexNowErr) {
        console.warn(`  ↳ [IndexNow] ⚠️ Ping failed (non-fatal): ${indexNowErr.message}`);
      }

      // 2. Google Sitemap Ping — request Google to re-crawl the sitemap
      // This is the ONLY legitimate way to signal Google for blog/news content
      try {
        const sitemapUrl = `https://${siteHost}/post-sitemap.xml`;
        await axios.get(
          `https://www.google.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`,
          { timeout: 10000 }
        );
        console.log(`  ↳ [Google Sitemap Ping] ✅ Notified Google to re-crawl sitemap`);
      } catch (sitemapErr) {
        console.warn(`  ↳ [Google Sitemap Ping] ⚠️ Failed (non-fatal): ${sitemapErr.message}`);
      }

      successCount++;
    } catch (parseErr) {
      console.error(`  ↳ [Indexer Error] Invalid URL "${articleUrl}": ${parseErr.message}`);
      failCount++;
    }
  }

  // Clean up temporary file
  try {
    fs.unlinkSync(urlFile);
  } catch (e) {
    console.warn(`[Indexer] Could not delete ${urlFile}: ${e.message}`);
  }

  console.log(`\n[Indexer] ✅ Complete. ${successCount} succeeded, ${failCount} failed. Cleaned up latest_url.txt.`);
}

runIndexer();
