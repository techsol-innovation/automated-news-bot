require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');

async function auditSitemaps() {
  console.log('--- Phase 4b: Live Sitemap Audit ---');
  if (!process.env.WP_URL) {
    console.error('❌ Missing WP_URL in .env file.');
    process.exit(1);
  }

  const wpUrl = process.env.WP_URL.replace(/\/$/, '');
  const indexSitemapUrl = `${wpUrl}/sitemap_index.xml`;
  
  try {
    console.log(`\n🔍 Fetching Sitemap Index: ${indexSitemapUrl}`);
    const indexRes = await axios.get(indexSitemapUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    const $index = cheerio.load(indexRes.data, { xmlMode: true });
    
    // Find all sitemaps inside the index
    const innerSitemapUrls = [];
    $index('sitemap loc').each((i, el) => {
      const url = $index(el).text();
      // We only care about post sitemaps
      if (url.includes('post-sitemap')) {
        innerSitemapUrls.push(url);
      }
    });

    if (innerSitemapUrls.length === 0) {
      console.log('⚠️ No post sitemaps found in the index.');
      process.exit(0);
    }
    
    console.log(`✅ Found ${innerSitemapUrls.length} post sitemap(s). Fetching contents...`);
    
    let allPostUrls = [];
    
    for (const sitemapUrl of innerSitemapUrls) {
      console.log(`  ↳ Fetching: ${sitemapUrl}`);
      const sitemapRes = await axios.get(sitemapUrl, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      const $postSitemap = cheerio.load(sitemapRes.data, { xmlMode: true });
      
      $postSitemap('url loc').each((i, el) => {
        allPostUrls.push($postSitemap(el).text());
      });
    }
    
    console.log(`\n📊 Total Live Post URLs Extracted: ${allPostUrls.length}`);
    
    // Scan for duplicate slugs using regex
    // Looks for a hyphen followed by 1 to 5 digits at the end of the URL or right before a trailing slash
    const duplicatePattern = /-\d{1,5}\/?$/;
    
    const duplicateUrls = allPostUrls.filter(url => duplicatePattern.test(url));
    
    console.log(`\n⚠️ Total Duplicates Found: ${duplicateUrls.length}`);
    if (duplicateUrls.length > 0) {
      console.log('--- List of Suspected Duplicates ---');
      duplicateUrls.forEach((url, i) => {
        console.log(`  ${i + 1}. ${url}`);
      });
      console.log('------------------------------------');
      console.log('\n❌ Health Status: FAILED (Duplicates detected in live sitemap)');
    } else {
      console.log('\n✅ Health Status: PASSED (No duplicates detected in live sitemap)');
    }

  } catch (error) {
    console.error(`\n❌ Error during sitemap audit: ${error.message}`);
    process.exit(1);
  }
}

auditSitemaps();
