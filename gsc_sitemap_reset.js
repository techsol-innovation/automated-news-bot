require('dotenv').config();
const { google } = require('googleapis');
const axios = require('axios');

async function resetSitemaps() {
  console.log('--- Phase 4: GSC Sitemap Reset & Verification ---');

  if (!process.env.WP_URL || !process.env.GSC_CREDENTIALS) {
    console.error('❌ Missing WP_URL or GSC_CREDENTIALS in .env file.');
    process.exit(1);
  }

  const wpUrl = process.env.WP_URL.replace(/\/$/, ''); // Base URL without trailing slash
  const gscSiteUrl = process.env.WP_URL; // Keep the format exactly as defined in .env for GSC API (usually has trailing slash)
  const rankMathSitemapUrl = `${wpUrl}/sitemap_index.xml`;

  // 1. Verify RankMath Sitemap
  console.log(`\n1️⃣  Verifying RankMath Sitemap at: ${rankMathSitemapUrl}`);
  try {
    const response = await axios.get(rankMathSitemapUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (response.status === 200 && response.data.includes('<?xml')) {
      console.log('✅ RankMath sitemap is active and serving XML data.');
    } else {
      console.error('❌ Sitemap verification failed: Invalid response format or status.');
      process.exit(1);
    }
  } catch (error) {
    console.error(`❌ Sitemap verification failed: ${error.message}`);
    process.exit(1);
  }

  // 2. Authenticate with Google Search Console API
  console.log('\n2️⃣  Authenticating with Google Search Console API...');
  let authClient;
  try {
    const credentials = JSON.parse(process.env.GSC_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/webmasters']
    });
    authClient = await auth.getClient();
    google.options({ auth: authClient });
    console.log('✅ Successfully authenticated with GSC API using service account.');
  } catch (error) {
    console.error(`❌ Authentication failed: ${error.message}`);
    process.exit(1);
  }

  const searchconsole = google.searchconsole('v1');

  // 3. Delete Bad Sitemaps
  console.log('\n3️⃣  Deleting bad/spam sitemaps...');
  const badSitemaps = [
    `${wpUrl}/post.sitemap.xml`,
    `${wpUrl}/post-sitemap.xml`
  ];

  for (const feedpath of badSitemaps) {
    try {
      console.log(`  ↳ Attempting to delete: ${feedpath}`);
      await searchconsole.sitemaps.delete({
        siteUrl: gscSiteUrl,
        feedpath: feedpath
      });
      console.log(`    ✅ Successfully deleted: ${feedpath}`);
    } catch (error) {
      // If it's already deleted or not found, GSC API might throw a 404, which is fine
      if (error.code === 404) {
        console.log(`    ⚠️ Not found (already deleted or never submitted): ${feedpath}`);
      } else {
        console.error(`    ❌ Failed to delete ${feedpath}: ${error.message}`);
      }
    }
  }

  // 4. Submit Clean Sitemap
  console.log('\n4️⃣  Submitting verified RankMath sitemap...');
  try {
    console.log(`  ↳ Submitting: ${rankMathSitemapUrl}`);
    await searchconsole.sitemaps.submit({
      siteUrl: gscSiteUrl,
      feedpath: rankMathSitemapUrl
    });
    console.log('  ✅ Successfully submitted the RankMath sitemap to Google Search Console.');
  } catch (error) {
    console.error(`  ❌ Failed to submit sitemap: ${error.message}`);
    process.exit(1);
  }

  console.log('\n🎉 GSC Sitemap Reset completed successfully!');
}

resetSitemaps().catch(error => {
  console.error('\n❌ Unhandled error during execution:', error);
  process.exit(1);
});
