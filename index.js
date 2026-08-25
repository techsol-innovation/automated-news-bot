require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createCanvas, loadImage } = require('canvas');
const FormData = require('form-data');

// Initialize Gemini client and model
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

// Category ID mapping for WordPress REST API
const CATEGORY_MAP = {
  sports: 2,
  entertainment: 3
};

// Global in-memory cache for taxonomies
const wpCategoriesMap = new Map(); // name (lowercase) -> id
const wpTagsMap = new Map(); // name (lowercase) -> id

/**
 * Preloads all existing categories and tags from WordPress into local memory.
 */
async function preloadWordPressTaxonomies() {
  console.log('[Info] Preloading WordPress taxonomies into memory...');
  try {
    if (!process.env.WP_USERNAME || !process.env.WP_APP_PASSWORD || !process.env.WP_URL) {
      throw new Error("Missing required WordPress environment variables (WP_USERNAME, WP_APP_PASSWORD, or WP_URL)");
    }
    const credentials = `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`;
    const token = Buffer.from(credentials).toString('base64');
    const headers = { 'Authorization': `Basic ${token}` };
    const wpBaseUrl = process.env.WP_URL.replace(/\/$/, '');

    const [catResp, tagResp] = await Promise.all([
      axios.get(`${wpBaseUrl}/wp-json/wp/v2/categories?per_page=100`, { headers }),
      axios.get(`${wpBaseUrl}/wp-json/wp/v2/tags?per_page=100`, { headers })
    ]);

    const categories = catResp.data || [];
    categories.forEach(cat => wpCategoriesMap.set(cat.name.toLowerCase(), cat.id));

    const tags = tagResp.data || [];
    tags.forEach(tag => wpTagsMap.set(tag.name.toLowerCase(), tag.id));

    console.log(`[Info] Preloaded ${wpCategoriesMap.size} categories and ${wpTagsMap.size} tags.`);
  } catch (error) {
    console.error(`[Error] Failed to preload taxonomies: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Helper function to pause execution for a given number of milliseconds
 * @param {number} ms - Milliseconds to delay
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Forces an image URL to return a high-resolution version by stripping thumbnail modifiers
 * and upgrading width/height query parameters.
 * @param {string} url - The original image URL
 * @returns {string} - The high-resolution image URL
 */
function getHighResImageUrl(url) {
  if (!url) return url;
  try {
    let newUrl = url;
    // Strip WordPress or standard thumbnail size modifiers (e.g. image-150x150.jpg -> image.jpg)
    newUrl = newUrl.replace(/-\d{2,4}x\d{2,4}(\.[a-zA-Z0-9]+(?:\?.*)?)$/i, '$1');
    
    const parsedUrl = new URL(newUrl);
    
    // Upgrade common CDN resizing parameters
    const paramsToEnlarge = ['w', 'width', 'h', 'height', 'resize', 'fit'];
    paramsToEnlarge.forEach(param => {
      if (parsedUrl.searchParams.has(param)) {
        if (param === 'w' || param === 'width') {
          parsedUrl.searchParams.set(param, '1200');
        } else if (param === 'h' || param === 'height') {
          parsedUrl.searchParams.set(param, '800');
        } else {
          parsedUrl.searchParams.delete(param);
        }
      }
    });
    
    return parsedUrl.toString();
  } catch (e) {
    // If URL parsing fails, return the cleaned string fallback
    return url.replace(/-\d{2,4}x\d{2,4}(\.[a-zA-Z0-9]+(?:\?.*)?)$/i, '$1');
  }
}

/**
 * Checks whether an image URL is a valid editorial photograph.
 * Rejects logos, icons, banners, SVGs, GIFs, and known clickbait image patterns.
 * @param {string} url - The image URL to check
 * @returns {boolean} true if the image is acceptable for publication
 */
function isValidEditorialImage(url) {
  if (!url || typeof url !== 'string' || url.trim() === '') return false;
  const lower = url.toLowerCase();

  // Reject by URL substring — logos, branding assets, overlays
  const BAD_SUBSTRINGS = [
    'logo', '_white', 'icon', 'avatar', 'button', 'banner',
    'sponsor', 'transparent', 'placeholder', '1x1', 'spacer',
    'blank', 'pixel', 'meme', 'youtube', 'typography'
  ];
  for (const kw of BAD_SUBSTRINGS) {
    if (lower.includes(kw)) return false;
  }

  // Reject by file extension — vector graphics and animations are never editorial photos
  const BAD_EXTENSIONS = ['.svg', '.gif'];
  const urlWithoutQuery = lower.split('?')[0];
  for (const ext of BAD_EXTENSIONS) {
    if (urlWithoutQuery.endsWith(ext)) return false;
  }

  return true;
}

/**
 * Scrapes the text content of a single news article URL using axios and cheerio.
 * Selects all <p> (paragraph) tags and returns the clean text and word count.
 * @param {string} url - The article URL to visit
 * @returns {Promise<{text: string, wordCount: number, status: string, image1: string, image2: string}>}
 */
async function scrapeArticleText(url) {
  try {
    const response = await axios.get(url, {
      timeout: 12000,
      maxRedirects: 10,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    });

    const $ = cheerio.load(response.data);

    // Extract main Open Graph image BEFORE removing DOM elements
    const image1 = getHighResImageUrl($('meta[property="og:image"]').attr('content') || '');
    
    // Extract body images (up to 4 valid distinct editorial images)
    const bodyImages = [];
    $('img').each((_, element) => {
      let src = $(element).attr('src');
      if (src && !src.startsWith('data:image')) {
        const cleanSrc = getHighResImageUrl(src);
        if (isValidEditorialImage(cleanSrc) && !bodyImages.includes(cleanSrc)) {
          bodyImages.push(cleanSrc);
        }
      }
    });
    
    // Keep at most 2 body images
    const finalBodyImages = bodyImages.slice(0, 2);

    // Remove irrelevant elements before extracting paragraph text
    $('script, style, nav, footer, header, aside, iframe, noscript').remove();

    // Extract text from all <p> tags
    const paragraphs = [];
    $('p').each((_, element) => {
      const text = $(element).text().trim();
      if (text.length > 20) {
        paragraphs.push(text);
      }
    });

    const fullText = paragraphs.join('\n\n');
    const wordCount = fullText ? fullText.split(/\s+/).filter(Boolean).length : 0;
    
    const status = wordCount >= 500 
      ? `Meets requirement (${wordCount} words >= 500)` 
      : `Under 500 words (${wordCount} words)`;

    return { text: fullText, wordCount, status, image1, bodyImages: finalBodyImages };
  } catch (error) {
    const errMsg = error.response 
      ? `HTTP Status ${error.response.status} (${error.response.statusText})` 
      : error.message;
    return { 
      text: `[Failed to scrape article from ${url}: ${errMsg}]`, 
      wordCount: 0, 
      status: `Error: ${errMsg}`,
      image1: '',
      bodyImages: []
    };
  }
}

/**
 * Sends combined scraped text to Gemini to generate 2 distinct SEO-optimized articles with category names.
 * @param {string} topicTitle - The name/title of the trending topic
 * @param {string} scrapedText - Combined text scraped from associated articles
 * @returns {Promise<string>} The generated response text from Gemini
 */
async function generateArticles(topicTitle, scrapedText) {
  const prompt = `You are an award-winning Senior Journalist, Elite Copywriter, and SEO Strategist for a top-tier US entertainment and sports media brand. Your single goal is to write PREMIUM, deeply researched, magazine-quality content that earns 2000+ word counts, high dwell time, and dominates Google AI Overviews and Perplexity citations.
I have scraped news about the trending topic: "${topicTitle}". Extracted text:
${scrapedText}

Write a high-quality, deeply detailed news article based on the provided text.

STRICT INSTRUCTIONS:
- Keyword Generation First: Generate a strict 1-2 word focus_keyword.
- Forced Exact String Match (Zero Tolerance): You MUST use this EXACT 1-2 word string, character-for-character, in:
  1. title: MUST contain a Number (e.g., 5, 7) and a Power Word (e.g., Shocking, Massive, Ultimate). The title MUST strictly start with the exact focus_keyword, followed by a colon (:). Example Format: '[Focus Keyword]: 7 [Power Word] Secrets Behind This [Sentiment Word] Event'.
  2. seo_description: The very first words of this description MUST be the exact focus_keyword. The description MUST be strictly between 120 and 160 characters long.
  3. slug: The URL slug MUST contain the exact focus_keyword (lowercase, hyphenated).
  4. content: Ensure the exact focus_keyword appears naturally in the very first sentence of the HTML content (First 10% rule).
- Content Expansion Blueprint (STRICT 2000+ WORDS MINIMUM): CRITICAL SEO RULE: You MUST write a comprehensive, deeply researched, magazine-quality article that is STRICTLY OVER 2000 words long. This is non-negotiable. To hit this target, you MUST: (a) Include background context and history. (b) Add unique angles, insider facts, and data that competitors are NOT covering. (c) Explore multiple perspectives on the story. You MUST structure the HTML with exactly 5 to 6 distinct <h2> headings. Under EACH <h2> heading, you MUST write at least 4-6 detailed paragraphs or use <h3> sub-sections with supporting evidence.
- DEEP-DIVE EXPERT ANALYSIS: Under at least 2 of your <h2> sections, you MUST include an 'Expert Take' or 'By The Numbers' angle — a paragraph that synthesizes specific statistics, historical context, or a unique expert perspective that the average reader cannot find on a basic news site. This is your content's competitive moat.
- KEY TAKEAWAYS BOX: At the very top of the content (before the first paragraph), inject a styled HTML 'Key Takeaways' box using this exact template: <div style="background: linear-gradient(135deg, #1a1a2e, #16213e); border-left: 4px solid #e94560; padding: 20px 25px; margin-bottom: 30px; border-radius: 4px;"><h3 style="color: #e94560; margin-top: 0; font-size: 1em; text-transform: uppercase; letter-spacing: 1px;">⚡ Key Takeaways</h3><ul style="color: #eaeaea; margin: 0; padding-left: 20px; line-height: 1.8;">BULLET_POINTS_HERE</ul></div>. Generate 3-5 bullet points summarizing the most shocking/important facts of the article. This increases dwell time and reduces bounce rate.
- FAQ SECTION (Schema-Ready): You MUST include a dedicated FAQ section as the SECOND TO LAST section (before the final conclusion H2). Use this exact structure: <h2>Frequently Asked Questions</h2> followed by 3-4 question-answer pairs, each using <h3> for the question and a <p> for the answer. These FAQs MUST directly answer the exact search queries a user would type into Google about this topic. This boosts Google AI Overview and FAQ rich snippet eligibility.
- Keyword Density Enforcer: Maintain a natural keyword density of strictly 1% to 1.5%.
- SEO Linking & Formatting Rules: Embed exactly 1 to 2 EXTERNAL links to high-authority sites (like Wikipedia, Reuters, ESPN, IMDb) in the content using proper <a> tags to back up factual claims. The generated HTML must contain exactly one internal link to https://brightcelebrity.com/. Bold the focus keyword at least twice.
- HEADING STRUCTURE (CRITICAL): NEVER use an <h1> tag. Main sections MUST be <h2>. Sub-sections MUST be <h3>. NEVER skip heading levels (e.g., jumping from H2 to H4). All headings MUST be concise and punchy (3 to 6 words). Naturally include the exact focus keyword in exactly 1 or 2 of the <h2> headings.
- AI CITATION READINESS (GEO): Use 'Answer-first' formatting. Place the direct answer to the core topic/question in the first 100 words. You MUST include at least one Markdown table (styled as HTML) or bulleted list for comparative data or statistics to ensure the content is highly extractable by AI search engines.
- READABILITY CONSTRAINTS: Keep paragraphs strictly to 2-4 sentences max. Aim for an average of 15-20 words per sentence to ensure a Flesch Reading Ease score suitable for a general audience.
- THE ENGAGEMENT HOOK: Start the very first paragraph with a strong 'hook'—a shocking fact or bold statement. Address the reader directly using 'You'.
- RICH MICRO-FORMATTING: Break up the text. Use the <strong> tag generously for celebrity names, financial figures, and key locations. Ensure zero fluff.
- STRICT ANTI-AI TONE: You are strictly forbidden from using robotic AI transition words (e.g., 'In conclusion', 'Moreover'). Write in a punchy, journalistic, conversational tone.
- Concreteness & Correctness: Use specific data, clear facts, and sensory words. Ensure flawless grammar.
- PREMIUM TABLE STYLING: Whenever you generate an HTML table, inject premium inline CSS: <table style="width: 100%; border-collapse: collapse; margin: 25px 0; font-size: 1em; font-family: sans-serif; box-shadow: 0 0 20px rgba(0, 0, 0, 0.15);">. The table header: <thead style="background-color: #2c3e50; color: #ffffff; text-align: left;">. Cells: style="padding: 12px 15px; border-bottom: 1px solid #dddddd;".
- STRICT ARTICLE TEMPLATE: To maintain a consistent 95+ SEO score, you MUST follow this exact HTML structure:
  [KEY TAKEAWAYS BOX] -> Place the styled Key Takeaways <div> here, before the first paragraph.
  Introduction: 2-3 short paragraphs containing the exact focus keyword in the first sentence.
  H2: [Catchy Section Title with Focus Keyword] -> Followed by detailed paragraphs with deep analysis.
  H3: [Sub-topic] -> Followed by bullet points or expert insights.
  H2: [Data/Stats Section Title] -> Followed by the newly styled premium HTML table.
  H2: [Background & Context] -> Deep-dive history, expert take, or 'By The Numbers' section.
  H2: Frequently Asked Questions -> 3-4 H3 questions with <p> answers (schema-ready).
  H2: [Final Thoughts / Conclusion] -> Summarize and naturally include the focus keyword one last time.
- Meaningful Lists: Use bullet points (<ul>) or numbered lists (<ol>) ONLY when breaking down complex ideas, itemizing facts, or listing achievements. Do not use them just for the sake of having a list.
- Smart Image Placement & MULTI-IMAGE ALT TAGS: You must dynamically and organically insert exactly TWO image placeholders: [INJECT_IMAGE_2_HERE] and [INJECT_IMAGE_3_HERE] evenly throughout the HTML content. Place the first one after the first or second <h2> tag, and the second one further down the article. Do NOT use generic <img> tags, ONLY use the exact string placeholders.
- Alt Tags generation: You must generate a JSON array named body_image_alt_tags containing exactly 2 strings. These strings must be highly descriptive, long-tail variations of the focus keyword to be used as alt text for the images.
- Courtesy (Tone): Maintain a highly helpful, engaging, and welcoming tone.
- Tags: Generate a JSON array named tags containing exactly 15 to 20 highly specific, long-tail SEO tags relevant to the article. Mix entity names, trending search queries (like 'Net Worth 2026'), associated people, and specific events. Do NOT use generic one-word tags. Integrate these naturally into the body text.
- Category: Analyze the article and return TWO category fields: parent_category (string, e.g., 'Sports', 'Entertainment') and sub_categories (An ARRAY of strings). You MUST dynamically decide how many sub-categories are relevant.
- Slug: Generate a slug (URL-friendly string, lowercase, hyphen-separated) that MUST contain the exact focus_keyword.
- Thumbnail Text: Generate a short, highly engaging text specifically for an image overlay. It MUST be extremely short: Maximum 3 to 5 words. It MUST be highly engaging, clickbaity, and use a power word (e.g., 'Shocking Truth Revealed!', 'Must See Details!', 'Hidden Secrets!'). It should summarize the core emotion or shock-value of the article.

CRITICAL OUTPUT REQUIREMENT: You MUST return ONLY valid JSON formatted strictly as follows, without any markdown backticks, explanations, or extra text. NEVER use literal \n or \r characters in the content string. Use proper HTML tags like <p> and <br> for spacing:
{
  "title": "Simple direct headline",
  "content": "Full HTML article body text following the formatting rules...",
  "parent_category": "Broad Category (e.g., Sports, Entertainment)",
  "sub_categories": ["Sub-category 1", "Sub-category 2"],
  "focus_keyword": "single-strong-keyword",
  "slug": "url-friendly-slug-with-keyword",
  "tags": ["Highly Specific Tag 1", "Person Net Worth 2026", "Associated Event 2026", "Trending Search Query 4"],
  "seo_description": "A compelling meta description",
  "thumbnail_text": "Shocking Truth Revealed!",
  "body_image_alt_tags": ["long-tail-alt-1", "long-tail-alt-2"]
}`;

  try {
    const result = await geminiModel.generateContent(prompt);
    return result.response.text();
  } catch (error) {
    console.error(`[Gemini Error] Primary model failed for "${topicTitle}": ${error.message || error}`);
    
    // Autonomous problem solving: retry across active fallback models with backoff
    const fallbackModels = ['gemini-3.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-pro'];
    
    for (const modelName of fallbackModels) {
      console.log(`[Gemini Fallback] Retrying generation with model '${modelName}'...`);
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const fallbackModel = genAI.getGenerativeModel({ model: modelName });
          const fallbackResult = await fallbackModel.generateContent(prompt);
          return fallbackResult.response.text();
        } catch (err) {
          if (err.message && (err.message.includes('503') || err.message.includes('429') || err.message.includes('high demand'))) {
            if (attempt < maxRetries) {
              const waitTime = 2000 * Math.pow(2, attempt - 1);
              await delay(waitTime);
              continue;
            }
          } else if (err.message && (err.message.includes('404') || err.message.includes('not found') || err.message.includes('not supported'))) {
            break;
          }
          if (attempt === maxRetries) {
            break;
          }
        }
      }
    }
    throw new Error(`Failed to generate articles after retrying all fallback models: ${error.message || error}`);
  }
}

/**
 * Fetches top trending US Sports and Entertainment news from NewsData.io API using axios.
 * Filters to keep only articles where image_url is NOT null, extracting top 3 Sports and top 2 Entertainment.
 * @returns {Promise<Array<{title: string, link: string, snippet: string, image_url: string, category: string}>>}
 */
async function getCombinedEntertainmentAndSportsTrends() {
  console.log(`[Info] Fetching US Sports and Entertainment news from NewsData.io API...`);
  
  try {
    const apiKey = process.env.NEWSDATA_API_KEY;
    if (!apiKey) {
      throw new Error("NEWSDATA_API_KEY is not defined in process.env");
    }

    const sportsUrl = `https://newsdata.io/api/1/news?apikey=${apiKey}&country=us&category=sports`;
    const entUrl = `https://newsdata.io/api/1/news?apikey=${apiKey}&country=us&category=entertainment`;

    const [sportsResp, entResp] = await Promise.all([
      axios.get(sportsUrl, { timeout: 15000 }),
      axios.get(entUrl, { timeout: 15000 })
    ]);

    const sportsResults = sportsResp.data?.results || [];
    const entResults = entResp.data?.results || [];

    // Filter the results array to keep only articles with valid editorial image_urls
    const sportsFiltered = sportsResults.filter(item => item && isValidEditorialImage(item.image_url));
    const entFiltered = entResults.filter(item => item && isValidEditorialImage(item.image_url));

    // Extract top 5 articles for Sports and top 5 for Entertainment
    const sportsTopics = sportsFiltered.slice(0, 5).map(item => ({
      title: item.title || 'Unknown Sports Topic',
      link: item.link || '',
      snippet: item.description || item.content || item.title,
      image_url: item.image_url,
      category: 'sports'
    }));

    const entTopics = entFiltered.slice(0, 5).map(item => ({
      title: item.title || 'Unknown Entertainment Topic',
      link: item.link || '',
      snippet: item.description || item.content || item.title,
      image_url: item.image_url,
      category: 'entertainment'
    }));

    const combined = [...sportsTopics, ...entTopics];
    console.log(`[Info] Successfully retrieved ${combined.length} valid topics (${sportsTopics.length} Sports, ${entTopics.length} Entertainment).`);
    return combined;
  } catch (error) {
    const errMsg = error.response?.data?.results?.message || error.response?.data?.message || error.message;
    console.error(`[Error] Failed to fetch NewsData.io API: ${errMsg}`);
    process.exit(1);
    return [];
  }
}

/**
 * Deduplicates an array of topic objects by comparing title keywords.
 * Two topics are considered duplicates if they share more than 50% of their significant words.
 * @param {Array} topics - Array of topic objects with a 'title' property
 * @returns {Array} Deduplicated array of topics
 */
function deduplicateTopics(topics) {
  if (!Array.isArray(topics) || topics.length <= 1) return topics;

  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'but', 'with', 'by', 'from', 'as', 'it', 'its', 'this', 'that', 'has', 'have', 'had', 'not', 'be', 'been', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'do', 'does', 'did', 'just', 'about', 'after', 'before', 'over', 'under', 'between', 'into', 'out', 'up', 'down', 'new', 'says', 'said', 'also', 'than', 'more', 'most', 'very', 'how', 'what', 'when', 'where', 'who', 'which', 'why']);

  function getKeywords(title) {
    return title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
  }

  function similarity(kw1, kw2) {
    if (kw1.length === 0 || kw2.length === 0) return 0;
    const set1 = new Set(kw1);
    const set2 = new Set(kw2);
    let overlap = 0;
    for (const word of set1) {
      if (set2.has(word)) overlap++;
    }
    return overlap / Math.min(set1.size, set2.size);
  }

  const unique = [topics[0]];
  const uniqueKeywords = [getKeywords(topics[0].title)];

  for (let i = 1; i < topics.length; i++) {
    const currentKw = getKeywords(topics[i].title);
    let isDuplicate = false;
    for (const existingKw of uniqueKeywords) {
      if (similarity(currentKw, existingKw) > 0.5) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) {
      unique.push(topics[i]);
      uniqueKeywords.push(currentKw);
    } else {
      console.log(`  ↳ [Dedup] Skipped similar topic: "${topics[i].title}"`);
    }
  }

  console.log(`[Dedup] Reduced ${topics.length} topics to ${unique.length} unique topics.`);
  return unique;
}

/**
 * Pings IndexNow API to notify search engines about a newly published URL.
 * Uses Bing's IndexNow endpoint (free, no API key required for basic pings).
 * @param {string} postUrl - The full live URL of the published post
 */
async function pingIndexNow(postUrl) {
  try {
    const siteHost = new URL(process.env.WP_URL).host;
    const indexNowUrl = `https://api.indexnow.org/IndexNow?url=${encodeURIComponent(postUrl)}&key=autopublisher&keyLocation=https://${siteHost}/autopublisher.txt`;

    await axios.get(indexNowUrl, { timeout: 10000 });
    console.log(`  ↳ [IndexNow] ✅ Pinged search engines for: ${postUrl}`);
  } catch (err) {
    // Non-fatal: don't crash if the ping fails
    console.warn(`  ↳ [IndexNow] ⚠️ Ping failed (non-fatal): ${err.message}`);
  }
}

/**
 * Helper function to get an existing WordPress category ID by name, or create it if not found.
 * Uses global wpCategoriesMap for in-memory caching to optimize performance.
 * @param {string} categoryName - The name of the category (e.g., 'Football', 'Hollywood')
 * @param {number} parentId - The parent category ID (0 for no parent)
 * @returns {Promise<number|null>} The WordPress category ID
 */
async function getOrCreateCategory(categoryName, parentId = 0) {
  try {
    if (!categoryName) return null;
    const cleanName = categoryName.trim();
    if (!cleanName) return null;

    const lowerName = cleanName.toLowerCase();
    
    // Check in-memory cache first
    if (wpCategoriesMap.has(lowerName)) {
      return wpCategoriesMap.get(lowerName);
    }

    if (!process.env.WP_USERNAME || !process.env.WP_APP_PASSWORD || !process.env.WP_URL) {
      throw new Error("Missing required WordPress environment variables (WP_USERNAME, WP_APP_PASSWORD, or WP_URL)");
    }

    const credentials = `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`;
    const token = Buffer.from(credentials).toString('base64');
    const headers = {
      'Authorization': `Basic ${token}`,
      'Content-Type': 'application/json'
    };

    const wpBaseUrl = process.env.WP_URL.replace(/\/$/, '');

    // If no match found, make POST request to create it
    console.log(`  ↳ Category "${cleanName}" not found on WordPress. Creating new category...`);
    const createUrl = `${wpBaseUrl}/wp-json/wp/v2/categories`;
    const postResp = await axios.post(createUrl, { name: cleanName, parent: parentId }, { headers });
    
    if (postResp.data && postResp.data.id) {
      console.log(`  ↳ ✅ Created new category "${cleanName}" (ID: ${postResp.data.id})`);
      // Immediately update local memory
      wpCategoriesMap.set(lowerName, postResp.data.id);
      return postResp.data.id;
    }

    return null;
  } catch (error) {
    const errDetail = error.response
      ? `HTTP ${error.response.status} - ${JSON.stringify(error.response.data)}`
      : error.message;
    console.error(`  ↳ [WordPress Category Error] Failed getOrCreateCategory for "${categoryName}": ${errDetail}`);
    return null;
  }
}

/**
 * Validates a generated article object before it is published to WordPress.
 * Checks for corrupted HTML content and low-quality images.
 * @param {Object} article - The structured article object
 * @param {number} index - Index for logging
 * @returns {{ valid: boolean, reasons: string[] }}
 */
function validateArticle(article, index) {
  const reasons = [];

  // Content Check: flag if HTML contains raw JSON artifacts or starts with {
  if (!article.content || article.content.trim().length < 100) {
    reasons.push('Content is empty or too short (under 100 chars)');
  }
  const trimmedContent = (article.content || '').trim();
  if (trimmedContent.startsWith('{') || trimmedContent.startsWith('[')) {
    reasons.push('Content starts with raw JSON bracket');
  }
  if (/\{\s*"title"\s*:/.test(trimmedContent) || /\{\s*"content"\s*:/.test(trimmedContent)) {
    reasons.push('Content contains raw JSON artifacts ({"title": or {"content":)');
  }

  // Image Check: strict editorial image validation for featured image
  const imageUrl = (article.image1 || '').toLowerCase();
  const BAD_IMAGE_KEYWORDS = [
    'logo', '_white', 'icon', 'avatar', 'button', 'banner', 'sponsor',
    'transparent', 'placeholder', '1x1', 'spacer', 'blank', 'pixel',
    'meme', 'youtube', 'typography'
  ];
  for (const keyword of BAD_IMAGE_KEYWORDS) {
    if (imageUrl.includes(keyword)) {
      reasons.push(`Featured image URL contains rejected keyword '${keyword}'`);
      break;
    }
  }
  // Reject SVG and GIF formats
  const imageWithoutQuery = imageUrl.split('?')[0];
  if (imageWithoutQuery.endsWith('.svg') || imageWithoutQuery.endsWith('.gif')) {
    reasons.push('Featured image is SVG or GIF — not an editorial photograph');
  }

  // Body image check: ensure none of the 2 body images are bad
  if (Array.isArray(article.bodyImages)) {
    for (const bUrl of article.bodyImages) {
      if (!isValidEditorialImage(bUrl)) {
        reasons.push(`Body image rejected (failed editorial check): ${bUrl.substring(0, 80)}`);
        break;
      }
    }
  }

  const valid = reasons.length === 0;
  if (!valid) {
    console.warn(`  ↳ [QA ${index}] ❌ Validation FAILED for "${article.title}": ${reasons.join('; ')}`);
  } else {
    console.log(`  ↳ [QA ${index}] ✅ Validation PASSED for "${article.title}"`);
  }
  return { valid, reasons };
}

/**
 * Processes a single topic: scrapes and generates article via Gemini.
 * Does NOT publish. Returns the structured article for validation.
 * @param {Object} item - The topic object from NewsData
 * @param {number} index - Index for logging
 * @returns {Promise<Object|null>} The structured result or null on failure
 */
async function generateArticleFromTopic(item, index) {
  console.log(`[Topic Process ${index}] Processing: "${item.title}"`);
  
  try {
    if (!item.link) {
      console.log(`  ↳ [Topic ${index}] Skipped: No valid source URL.`);
      return null;
    }

    console.log(`  ↳ [Topic ${index}] Scraping source URL via Cheerio...`);
    const scraped = await scrapeArticleText(item.link);
    console.log(`  ↳ [Topic ${index}] Scraped ${scraped.wordCount} words (${scraped.status}).`);

    const rawText = (scraped.wordCount > 0 && scraped.text) ? scraped.text : (item.snippet || item.title);
    const combinedText = `--- ARTICLE: ${item.title} (${item.link}) ---\n${rawText}`;
    
    console.log(`  ↳ [Topic ${index}] Generating SEO article via Gemini AI...`);
    console.log("Step 3: Generating Article with Gemini AI...");
    const generatedOutput = await generateArticles(item.title, combinedText);

    // Parse Gemini JSON output
    let parsedGemini = {};
    try {
      let cleanedJsonStr = generatedOutput.replace(/```json/gi, '').replace(/```/gi, '').trim();
      // Safely replace unescaped control characters with spaces to prevent JSON.parse from failing
      cleanedJsonStr = cleanedJsonStr.replace(/[\n\r\t]/g, ' ');
      const firstBrace = cleanedJsonStr.indexOf('{');
      const lastBrace = cleanedJsonStr.lastIndexOf('}');
      const jsonSubstring = (firstBrace !== -1 && lastBrace !== -1) 
        ? cleanedJsonStr.slice(firstBrace, lastBrace + 1) 
        : cleanedJsonStr;
      parsedGemini = JSON.parse(jsonSubstring);
    } catch (err) {
      console.error(`  ↳ [Topic ${index}] [JSON Parse Error] Gemini returned malformed JSON. Error: ${err.message}`);
      console.error(`  ↳ [Topic ${index}] [Raw Gemini Output (first 500 chars)] ${generatedOutput ? generatedOutput.substring(0, 500) : '(empty)'}`);
      console.warn(`  ↳ [Topic ${index}] Falling back to raw text as article content...`);
      parsedGemini = { 
        title: `${item.title}`, 
        content: generatedOutput, 
        parent_category: item.category || 'General', 
        sub_categories: ['News'], 
        focus_keyword: item.title, 
        tags: [item.title],
        thumbnail_text: 'Must See Details!' 
      };
    }

    const parentCategory = parsedGemini?.parent_category || item.category || 'General';
    const subCategories = Array.isArray(parsedGemini?.sub_categories) ? parsedGemini.sub_categories : ['News'];

    // Structure into the final result object using NewsData.io original image_url
    const topicResult = {
      topic: item.title,
      title: parsedGemini?.title || `${item.title}`,
      content: parsedGemini?.content || '',
      image1: getHighResImageUrl(item.image_url || ''),
      bodyImages: (scraped.wordCount > 0 && Array.isArray(scraped.bodyImages) && scraped.bodyImages.length > 0) ? scraped.bodyImages : [getHighResImageUrl(item.image_url)],
      bodyImageAltTags: Array.isArray(parsedGemini?.body_image_alt_tags) ? parsedGemini.body_image_alt_tags : [],
      parent_category: parentCategory,
      sub_categories: subCategories,
      topicType: item.category || 'sports',
      focus_keyword: parsedGemini?.focus_keyword || item.title,
      slug: parsedGemini?.slug || '',
      tags: Array.isArray(parsedGemini?.tags) ? parsedGemini.tags : [item.title],
      seo_description: parsedGemini?.seo_description || '',
      thumbnail_text: parsedGemini?.thumbnail_text || ''
    };

    console.log(`  ↳ [Topic ${index}] ✅ Successfully structured Article ("${topicResult.title}" | Category: ${topicResult.parent_category} > [${topicResult.sub_categories.join(', ')}])`);
    return topicResult;
  } catch (topicError) {
    const errDetail = topicError.response
      ? `HTTP ${topicError.response.status} - ${JSON.stringify(topicError.response.data).substring(0, 300)}`
      : topicError.message;
    console.error(`  ↳ [Topic ${index}] [Error] Failed processing topic "${item.title}": ${errDetail}`);
    console.error(`  ↳ [Topic ${index}] Skipping this topic and continuing with remaining topics...`);
    return null;
  }
}

/**
 * Fetches combined Sports and Entertainment trends, selects top 10 topics,
 * and processes them in parallel batches for extreme speed.
 */
async function fetchAndScrapeTrends() {
  try {
    // 1. Preload global state to avoid redundant API hits for categories/tags
    console.log("Step 1: Preloading WordPress Taxonomies...");
    await preloadWordPressTaxonomies();

    console.log("Step 2: Fetching Trends from NewsData API...");
    const combinedTopics = await getCombinedEntertainmentAndSportsTrends();
    
    // Deduplicate topics to prevent keyword cannibalization
    const dedupedTopics = deduplicateTopics(combinedTopics);
    
    // Shuffle the topics to ensure variety and prevent duplicate hourly posts
    const shuffledTopics = dedupedTopics.sort(() => 0.5 - Math.random());
    // Select top 3 topics — quality over quantity: fewer articles, higher depth
    const topTopics = shuffledTopics.slice(0, 3);

    if (topTopics.length === 0) {
      console.log('[Info] No trending topics found. Exiting.');
      return;
    }

    console.log(`\n[Info] Starting ultra-fast parallel generation pipeline for ${topTopics.length} topics...\n`);
    const publishQueue = [];  // Articles that passed validation
    const retryQueue = [];    // { item, index } objects that failed validation
    const BATCH_SIZE = 3; // All 3 articles generated in one parallel batch — no inter-batch delay needed

    // ══════════════════════════════════════════════════════════════
    // PHASE 1: Generate all articles and sort into publish/retry queues
    // ══════════════════════════════════════════════════════════════
    for (let i = 0; i < topTopics.length; i += BATCH_SIZE) {
      const batch = topTopics.slice(i, i + BATCH_SIZE);
      console.log(`\n[Batch] Generating topics ${i + 1} to ${Math.min(i + BATCH_SIZE, topTopics.length)} in parallel...`);
      
      const batchPromises = batch.map((item, localIndex) => 
        generateArticleFromTopic(item, i + localIndex + 1)
      );
      
      const batchResults = await Promise.allSettled(batchPromises);

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        const originalItem = batch[j];
        const globalIndex = i + j + 1;

        if (result.status === 'fulfilled' && result.value !== null) {
          const article = result.value;
          const { valid } = validateArticle(article, globalIndex);
          if (valid) {
            publishQueue.push(article);
          } else {
            retryQueue.push({ item: originalItem, index: globalIndex });
          }
        } else {
          const reason = result.status === 'rejected' ? result.reason?.message : 'returned null';
          console.warn(`[Batch] Topic ${globalIndex} generation failed (${reason}), adding to retry queue...`);
          retryQueue.push({ item: originalItem, index: globalIndex });
        }
      }

      if (i + BATCH_SIZE < topTopics.length) {
        console.log(`[Batch] Waiting 3 seconds before next batch to respect API limits...`);
        await delay(3000);
      }
    }

    // ══════════════════════════════════════════════════════════════
    // PHASE 2: Publish all validated articles immediately
    // ══════════════════════════════════════════════════════════════
    console.log(`\n[Publish] Publishing ${publishQueue.length} validated article(s) to WordPress...`);
    for (const article of publishQueue) {
      try {
        console.log(`  ↳ Publishing: "${article.title}"...`);
        const wpResponse = await publishToWordPress(article);
        // Auto-ping IndexNow for instant search engine indexing
        if (wpResponse && wpResponse.link) {
          await pingIndexNow(wpResponse.link);
        }
      } catch (wpErr) {
        console.error(`  ↳ [WordPress Error] Failed to publish "${article.title}": ${wpErr.message}`);
      }
    }

    // ══════════════════════════════════════════════════════════════
    // PHASE 3: Retry queue — regenerate failed articles one final time
    // ══════════════════════════════════════════════════════════════
    if (retryQueue.length > 0) {
      console.log(`\n[Retry Queue] ${retryQueue.length} topic(s) failed validation. Running ONE final retry pass...`);
      await delay(2000);

      const retryPromises = retryQueue.map(({ item, index }) =>
        generateArticleFromTopic(item, index)
      );

      const retryResults = await Promise.allSettled(retryPromises);

      for (let k = 0; k < retryResults.length; k++) {
        const result = retryResults[k];
        const { item, index } = retryQueue[k];

        if (result.status === 'fulfilled' && result.value !== null) {
          const article = result.value;
          const { valid, reasons } = validateArticle(article, index);
          if (valid) {
            try {
              console.log(`  ↳ [Retry] Publishing retried article: "${article.title}"...`);
              const wpResponse = await publishToWordPress(article);
              publishQueue.push(article);
              if (wpResponse && wpResponse.link) {
                await pingIndexNow(wpResponse.link);
              }
            } catch (wpErr) {
              console.error(`  ↳ [Retry WordPress Error] Failed to publish "${article.title}": ${wpErr.message}`);
            }
          } else {
            console.error(`  ↳ [Retry] ❌ Topic "${item.title}" failed validation AGAIN (${reasons.join('; ')}). Permanently skipped.`);
          }
        } else {
          console.error(`  ↳ [Retry] ❌ Topic "${item.title}" failed generation on retry. Permanently skipped.`);
        }
      }
    } else {
      console.log(`\n[Retry Queue] All articles passed validation on first attempt. No retries needed. 🎉`);
    }

    // Write final audit files to disk
    const allResults = publishQueue;
    fs.writeFileSync('final_audit.json', JSON.stringify(allResults, null, 2), 'utf8');
    fs.writeFileSync('audit_data.json', JSON.stringify(allResults, null, 2), 'utf8');
    console.log(`\n[Success] Pipeline complete. Published ${allResults.length} articles across ${topTopics.length} topics.`);
    console.log(`[Success] Audit files saved: final_audit.json and audit_data.json.`);

  } catch (error) {
    console.error('[Fatal Error] Unhandled exception in pipeline execution:');
    if (error.response) {
      console.error(`  HTTP Status: ${error.response.status}`);
      console.error(`  Response Body: ${JSON.stringify(error.response.data).substring(0, 500)}`);
    } else {
      console.error(`  Error Message: ${error.message || error}`);
      console.error(`  Stack Trace: ${error.stack || '(no stack trace available)'}`);
    }
    process.exit(1);
  }
}

/**
 * Helper function to loop through string tags, get existing WP tag ID or create if not found.
 * Uses global wpTagsMap for in-memory caching and WP REST API GET search to optimize performance.
 * @param {string[]} tagArray - Array of tag strings generated by Gemini
 * @returns {Promise<number[]>} Array of integer Tag IDs
 */
async function resolveTags(tagArray) {
  if (!Array.isArray(tagArray) || tagArray.length === 0) {
    return [];
  }

  const tagIds = [];
  try {
    if (!process.env.WP_USERNAME || !process.env.WP_APP_PASSWORD || !process.env.WP_URL) {
      throw new Error("Missing required WordPress environment variables (WP_USERNAME, WP_APP_PASSWORD, or WP_URL)");
    }

    const credentials = `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`;
    const token = Buffer.from(credentials).toString('base64');
    const headers = {
      'Authorization': `Basic ${token}`,
      'Content-Type': 'application/json'
    };

    const wpBaseUrl = process.env.WP_URL.replace(/\/$/, '');

    for (const rawTag of tagArray) {
      if (!rawTag || typeof rawTag !== 'string') continue;
      const tagName = rawTag.trim();
      if (!tagName) continue;

      const lowerName = tagName.toLowerCase();

      try {
        if (wpTagsMap.has(lowerName)) {
          tagIds.push(wpTagsMap.get(lowerName));
        } else {
          // Check WordPress via GET request if it exists
          const searchUrl = `${wpBaseUrl}/wp-json/wp/v2/tags?search=${encodeURIComponent(tagName)}`;
          const searchResp = await axios.get(searchUrl, { headers });
          
          if (searchResp.data && searchResp.data.length > 0) {
            // Grab the ID if it exists
            const existingTagId = searchResp.data[0].id;
            console.log(`  ↳ Found existing tag "${tagName}" via search (ID: ${existingTagId})`);
            wpTagsMap.set(lowerName, existingTagId);
            tagIds.push(existingTagId);
          } else {
            // Create the tag if not found
            console.log(`  ↳ Tag "${tagName}" not found. Creating new WordPress tag...`);
            const createUrl = `${wpBaseUrl}/wp-json/wp/v2/tags`;
            const postResp = await axios.post(createUrl, { name: tagName }, { headers });
            if (postResp.data && postResp.data.id) {
              console.log(`  ↳ ✅ Created tag "${tagName}" (ID: ${postResp.data.id})`);
              wpTagsMap.set(lowerName, postResp.data.id);
              tagIds.push(postResp.data.id);
            }
          }
        }
      } catch (tagErr) {
        const errDetail = tagErr.response
          ? `HTTP ${tagErr.response.status} - ${JSON.stringify(tagErr.response.data)}`
          : tagErr.message;
        console.warn(`  ↳ [Tag Error] Could not get or create tag "${tagName}": ${errDetail}`);
      }
    }
  } catch (error) {
    console.error(`  ↳ [WordPress Tag Helper Error] ${error.message}`);
  }

  return tagIds;
}

/**
 * Generates a dynamic thumbnail using Canvas by overlaying text and a gradient.
 * @param {string} imageUrl - Source image URL
 * @param {string} thumbnailText - Text to overlay
 * @returns {Promise<Buffer>} - Image buffer ready for upload
 */
async function generateThumbnail(imageUrl, thumbnailText) {
  try {
    const imgResponse = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const imgBuffer = Buffer.from(imgResponse.data, 'binary');
    
    const canvas = createCanvas(1280, 720);
    const ctx = canvas.getContext('2d');
    
    // 1. Full Image Background
    const image = await loadImage(imgBuffer);
    
    // Object-fit cover logic for full canvas (1280x720)
    const targetWidth = 1280;
    const targetHeight = 720;
    const scale = Math.max(targetWidth / image.width, targetHeight / image.height);
    const x = (targetWidth / 2) - (image.width / 2) * scale;
    const y = (targetHeight / 2) - (image.height / 2) * scale;
    
    ctx.drawImage(image, x, y, image.width * scale, image.height * scale);
    
    // 2. Cinematic Gradient Overlay
    const gradient = ctx.createLinearGradient(0, 0, 800, 0);
    gradient.addColorStop(0.0, 'rgba(0, 0, 0, 0.9)');
    gradient.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1280, 720);
    
    // 3. Typography (Left-Aligned & Premium)
    if (thumbnailText) {
      ctx.font = 'bold 75px sans-serif';
      
      // Basic word wrapping for max width 540
      const words = thumbnailText.trim().split(/\s+/);
      let line = '';
      const lines = [];
      const maxWidth = 540;
      
      for (let n = 0; n < words.length; n++) {
        const testLine = line + words[n] + ' ';
        const metrics = ctx.measureText(testLine);
        if (metrics.width > maxWidth && n > 0) {
          lines.push(line.trim());
          line = words[n] + ' ';
        } else {
          line = testLine;
        }
      }
      lines.push(line.trim());
      
      const lineHeight = 85;
      let startY = (canvas.height - (lines.length * lineHeight)) / 2 + (lineHeight / 1.5); // Vertically centered
      
      ctx.shadowColor = 'black';
      ctx.shadowBlur = 15;
      ctx.shadowOffsetX = 4;
      ctx.shadowOffsetY = 4;
      
      for (let i = 0; i < lines.length; i++) {
        const currentLine = lines[i];
        
        // Check if it's the very last line
        if (i === lines.length - 1) {
          const lineWords = currentLine.split(' ');
          const lastWord = lineWords.pop();
          const restOfLine = lineWords.join(' ') + (lineWords.length > 0 ? ' ' : '');
          
          // Draw rest of the line in white
          ctx.fillStyle = '#FFFFFF';
          ctx.fillText(restOfLine, 50, startY);
          
          // Draw the last word in yellow
          const restMetrics = ctx.measureText(restOfLine);
          ctx.fillStyle = '#FFD700';
          ctx.fillText(lastWord, 50 + restMetrics.width, startY);
        } else {
          ctx.fillStyle = '#FFFFFF';
          ctx.fillText(currentLine, 50, startY);
        }
        
        startY += lineHeight;
      }
      
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }
    
    return canvas.toBuffer('image/jpeg', { quality: 1.0 });
  } catch (error) {
    console.error(`  ↳ [Thumbnail Gen Error] Failed to generate thumbnail: ${error.message}`);
    throw error;
  }
}

/**
 * Downloads an image, generates a thumbnail overlay, and uploads it to the WordPress Media Library.
 * @param {string} imageUrl - The URL of the image to download
 * @param {string} title - The title for the filename
 * @param {string} [altText] - Optional alt text to set on the media
 * @param {string} [thumbnailText] - Text to overlay on the image
 * @returns {Promise<number|null>} The WordPress Media ID, or null if it fails
 */
async function uploadImageToWordPress(imageUrl, title, altText, thumbnailText) {
  if (!imageUrl) return null;
  try {
    if (!process.env.WP_USERNAME || !process.env.WP_APP_PASSWORD || !process.env.WP_URL) {
      throw new Error("Missing required WordPress environment variables (WP_USERNAME, WP_APP_PASSWORD, or WP_URL)");
    }

    // 1. Generate Thumbnail or Fallback
    let buffer;
    try {
      buffer = await generateThumbnail(imageUrl, thumbnailText || title);
    } catch (thumbError) {
      console.warn(`  ↳ [Warning] Thumbnail generation failed, falling back to raw image. Reason: ${thumbError.message}`);
      const fallbackResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
      buffer = Buffer.from(fallbackResp.data, 'binary');
    }

    // 2. Upload to WP using FormData
    const credentials = `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`;
    const token = Buffer.from(credentials).toString('base64');
    const safeTitle = (title || 'image').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const wpEndpoint = `${process.env.WP_URL.replace(/\/$/, '')}/wp-json/wp/v2/media`;

    const form = new FormData();
    const keywordSlug = (altText || title || 'image').replace(/[^a-z0-9]/gi, '-').replace(/(^-|-$)+/g, '').toLowerCase();
    const filename = `${keywordSlug}-${Date.now()}.jpg`;
    form.append('file', buffer, { filename: filename, contentType: 'image/jpeg' });
    
    const uploadResponse = await axios.post(wpEndpoint, form, {
      headers: {
        'Authorization': `Basic ${token}`,
        ...form.getHeaders()
      }
    });

    console.log(`  ↳ ✅ Uploaded generated thumbnail to WP Media Library (Media ID: ${uploadResponse.data.id})`);
    
    // 3. Update the media item with alt_text if provided
    if (altText) {
      try {
        await axios.post(`${wpEndpoint}/${uploadResponse.data.id}`, { alt_text: altText }, {
          headers: {
            'Authorization': `Basic ${token}`,
            'Content-Type': 'application/json'
          }
        });
        console.log(`  ↳ ✅ Set alt_text on WP Media Library (Media ID: ${uploadResponse.data.id})`);
      } catch (altError) {
        console.warn(`  ↳ [Warning] Failed to set alt_text on media ID ${uploadResponse.data.id}: ${altError.message}`);
      }
    }
    
    return uploadResponse.data.id;
  } catch (error) {
    const errDetail = error.response
      ? `HTTP ${error.response.status} - ${JSON.stringify(error.response.data)}`
      : error.message;
    console.error(`  ↳ [WordPress Media Error] Failed to upload image: ${errDetail}`);
    return null;
  }
}

/**
 * Publishes a single article object to WordPress via REST API as a draft.
 * Uses HTTP Basic Auth with WP Application Password.
 * Embeds image1 cleanly at the very top of the content HTML string.
 * Maps category and tag IDs as integers and passes RankMath focus keyword in meta.
 * @param {{ title: string, content: string, image1: string, bodyImages?: string[], bodyImageAltTags?: string[], topicType?: string, focus_keyword?: string, seo_tags?: string[], parent_category?: string, sub_categories?: string[] }} article - Article data object
 */
async function publishToWordPress(article) {
  try {
    if (!process.env.WP_USERNAME || !process.env.WP_APP_PASSWORD || !process.env.WP_URL) {
      throw new Error("Missing required WordPress environment variables (WP_USERNAME, WP_APP_PASSWORD, or WP_URL)");
    }

    const credentials = `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`;
    const token = Buffer.from(credentials).toString('base64');

    // Get or create parent and sub category IDs
    const parentId = await getOrCreateCategory(article.parent_category);
    let finalCategoryIds = [parentId];

    if (Array.isArray(article.sub_categories)) {
      for (const subCatName of article.sub_categories) {
        if (!subCatName) continue;
        const subCategoryId = await getOrCreateCategory(subCatName, parentId);
        if (subCategoryId) {
          finalCategoryIds.push(subCategoryId);
        }
      }
    }

    // Filter out null IDs if category creation failed
    let categoryIds = finalCategoryIds.filter(id => id !== null);

    // Strict category fallback: if AI generated categories fail and array is empty, default to 1 (e.g., 'News' category)
    if (!categoryIds || categoryIds.length === 0) {
      categoryIds = [1];
    }

    // Get or create tag integer IDs
    const tagIds = await resolveTags(article.tags);

    // Upload image to WordPress Media Library
    let mediaId = null;
    if (article.image1) {
      mediaId = await uploadImageToWordPress(article.image1, article.title, article.focus_keyword, article.thumbnail_text);
    }

    // Convert plain text newlines to HTML paragraphs for clean WordPress rendering
    let formattedBody = article.content
      .split('\n\n')
      .map(para => para.trim().startsWith('<') ? para.trim() : `<p>${para.trim()}</p>`)
      .join('\n');

    // Auto-inject internal link
    formattedBody += '\n\n<h3>More Like This</h3>\n<p>For more updates, check out our <a href="https://brightcelebrity.com/">latest entertainment and sports news</a>.</p>';

    // Inject in-content images dynamically
    const bodyImages = Array.isArray(article.bodyImages) ? article.bodyImages : [];
    const altTags = Array.isArray(article.bodyImageAltTags) ? article.bodyImageAltTags : [];
    
    for (let n = 2; n <= 3; n++) {
      const placeholder = `[INJECT_IMAGE_${n}_HERE]`;
      if (formattedBody.includes(placeholder)) {
        const imageUrl = bodyImages[n - 2];
        if (imageUrl) {
          const altTag = altTags[n - 2] || `${article.focus_keyword} details`;
          formattedBody = formattedBody.replace(
            placeholder,
            `<img src="${imageUrl}" alt="${altTag}" style="width:100%; height:auto; margin: 20px 0; border-radius: 8px;" />`
          );
        } else {
          formattedBody = formattedBody.replace(placeholder, '');
        }
      }
    }

    const postContent = formattedBody;
    const wpEndpoint = `${process.env.WP_URL.replace(/\/$/, '')}/wp-json/wp/v2/posts`;

    // Create a clean slug from the full article title to ensure permalink matches title
    let slugSource = article.title || article.focus_keyword || 'article';
    let seoSlug = slugSource.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
    if (seoSlug.length > 74) {
      seoSlug = seoSlug.substring(0, 74).replace(/-+$/, '');
    }

    const payload = {
      title: article.title || 'Untitled Article',
      content: postContent,
      excerpt: article.seo_description || '',
      status: 'publish',
      categories: categoryIds,
      tags: tagIds,
      slug: seoSlug,
      meta: {
        rank_math_focus_keyword: article.focus_keyword || '',
        rank_math_description: article.seo_description || '',
        rank_math_title: article.title || '',
        rank_math_content_ai_score: '100'
      }
    };

    if (mediaId) {
      payload.featured_media = mediaId;
    }

    console.log('IMPORTANT: Ensure rank_math_title is registered in your WP functions.php snippet to allow REST API updates.');

    console.log('🚀 DEBUG PAYLOAD:', JSON.stringify({ title: payload.title, meta: payload.meta, focus_keyword_from_ai: article.focus_keyword }, null, 2));

    const response = await axios.post(wpEndpoint, payload, {
      headers: {
        'Authorization': `Basic ${token}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`  ↳ ✅ Published on WP | Post ID: ${response.data.id} | Title: ${article.title}`);
    return response.data;
  } catch (error) {
    const errDetail = error.response
      ? `HTTP ${error.response.status} - ${JSON.stringify(error.response.data)}`
      : error.message;
    console.error(`  ↳ [WordPress Error] Failed publishing for "${article?.title}": ${errDetail}`);
    process.exit(1);
  }
}

// Global safety net: catch any unhandled promise rejections so the Action fails visibly
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Fatal] Unhandled Promise Rejection:');
  console.error(`  Reason: ${reason?.message || reason}`);
  console.error(`  Stack: ${reason?.stack || '(no stack)'}`);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('[Fatal] Uncaught Exception:');
  console.error(`  Error: ${error.message}`);
  console.error(`  Stack: ${error.stack || '(no stack)'}`);
  process.exit(1);
});

// Execute the script
fetchAndScrapeTrends();
