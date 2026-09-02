const fs = require('fs');
const { google } = require('googleapis');

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

  if (!process.env.GSC_CREDENTIALS) {
    console.error('[Indexer Error] GSC_CREDENTIALS environment variable is missing.');
    process.exit(1);
  }

  let credentials;
  try {
    credentials = JSON.parse(process.env.GSC_CREDENTIALS);
  } catch (err) {
    console.error('[Indexer Error] Failed to parse GSC_CREDENTIALS JSON string:', err.message);
    process.exit(1);
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/webmasters',
        'https://www.googleapis.com/auth/indexing'
      ],
    });

    const searchconsole = google.searchconsole({ version: 'v1', auth });
    const indexing = google.indexing({ version: 'v3', auth });

    for (const articleUrl of newUrls) {
      console.log(`\n[Indexer] Processing URL: ${articleUrl}`);
      
      const urlObj = new URL(articleUrl);
      const siteUrl = `${urlObj.protocol}//${urlObj.host}/`;
      const sitemapUrl = `${siteUrl}post-sitemap.xml`;

      // 1. Submit Sitemap Ping
      try {
        await searchconsole.sitemaps.submit({
          siteUrl: siteUrl,
          feedpath: sitemapUrl
        });
        console.log(`  ↳ [Search Console] ✅ Successfully pinged sitemap: ${sitemapUrl}`);
      } catch (err) {
        console.warn(`  ↳ [Search Console Warning] Failed to ping sitemap: ${err.message}`);
      }

      // 2. Submit URL_UPDATED Notification
      try {
        await indexing.urlNotifications.publish({
          requestBody: {
            url: articleUrl,
            type: 'URL_UPDATED'
          }
        });
        console.log(`  ↳ [Indexing API] ✅ Successfully submitted URL_UPDATED for: ${articleUrl}`);
      } catch (err) {
        console.error(`  ↳ [Indexing API Error] Failed to submit URL_UPDATED: ${err.message}`);
      }
    }

    // Clean up temporary file
    fs.unlinkSync(urlFile);
    console.log('\n[Indexer] ✅ Processing complete. Cleaned up latest_url.txt.');

  } catch (error) {
    console.error(`[Indexer Fatal Error] ${error.message}`);
    process.exit(1);
  }
}

runIndexer();
