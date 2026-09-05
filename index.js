require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createCanvas, loadImage } = require('canvas');
const FormData = require('form-data');
const DDG = require('duck-duck-scrape');

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
    
    // Categories and Tags are public endpoints. We omit the Authorization header on GET requests 
    // because caching layers (like Cloudflare/WP Rocket) often strip it, causing WordPress to 
    // fallback to cookie auth and throw 'rest_cookie_invalid_nonce' 403 errors on GitHub Actions.
    const getHeaders = { 
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' 
    };

    const [catResp, tagResp] = await Promise.all([
      axios.get(`${wpBaseUrl}/wp-json/wp/v2/categories?per_page=100&_nocache=${Date.now()}`, { headers: getHeaders }),
      axios.get(`${wpBaseUrl}/wp-json/wp/v2/tags?per_page=100&_nocache=${Date.now()}`, { headers: getHeaders })
    ]);

    const categories = catResp.data || [];
    categories.forEach(cat => wpCategoriesMap.set(cat.name.toLowerCase(), cat.id));

    const tags = tagResp.data || [];
    tags.forEach(tag => wpTagsMap.set(tag.name.toLowerCase(), tag.id));

    console.log(`[Info] Preloaded ${wpCategoriesMap.size} categories and ${wpTagsMap.size} tags.`);
  } catch (error) {
    const errDetail = error.response
      ? `HTTP ${error.response.status} - ${JSON.stringify(error.response.data)}`
      : (error.message || JSON.stringify(error));
    console.error(`[Error] Failed to preload taxonomies: ${errDetail}`);
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
 * Fetches real editorial photographs of a specific person using DuckDuckGo Image Search.
 * Falls back to Wikimedia Commons REST API if DDG returns no results.
 * All returned URLs pass through the 4-Layer Image Validation filter.
 * @param {string} subjectName - The full name of the person (e.g., 'Taylor Swift')
 * @param {number} count - Number of images to return (default 4)
 * @returns {Promise<string[]>} Array of validated high-resolution image URLs
 */
async function fetchRealSubjectImages(subjectName, count = 4) {
  if (!subjectName || typeof subjectName !== 'string' || subjectName.trim().length < 2) {
    return [];
  }

  const validImages = [];
  const seenUrls = new Set();

  // ── Layer 1: DuckDuckGo Image Search ──
  try {
    console.log(`  ↳ [Image Sourcer] Searching DuckDuckGo for real photos of "${subjectName}"...`);
    const ddgResults = await DDG.image(`${subjectName} high quality editorial photo`, {
      safeSearch: DDG.SafeSearchType.STRICT
    });

    const results = ddgResults?.results || [];
    for (const img of results) {
      if (validImages.length >= count) break;
      const imgUrl = img.image || img.thumbnail;
      if (!imgUrl || seenUrls.has(imgUrl)) continue;
      seenUrls.add(imgUrl);

      if (isValidEditorialImage(imgUrl)) {
        validImages.push(getHighResImageUrl(imgUrl));
      }
    }
    console.log(`  ↳ [Image Sourcer] DuckDuckGo returned ${validImages.length} valid editorial image(s).`);
  } catch (ddgErr) {
    console.warn(`  ↳ [Image Sourcer Warning] DuckDuckGo search failed: ${ddgErr.message}`);
  }

  // ── Layer 2: Wikimedia Commons REST API Fallback ──
  if (validImages.length < count) {
    try {
      console.log(`  ↳ [Image Sourcer] Falling back to Wikimedia Commons for "${subjectName}"...`);
      const wikiResp = await axios.get(
        `https://commons.wikimedia.org/w/api.php?action=query&generator=images&titles=${encodeURIComponent(subjectName)}&prop=imageinfo&iiprop=url|size&iiurlwidth=1200&gimlimit=20&format=json`,
        { timeout: 10000, headers: { 'User-Agent': 'CraftZoneBot/1.0 (news automation)' } }
      );
      const pages = wikiResp.data?.query?.pages || {};
      for (const page of Object.values(pages)) {
        if (validImages.length >= count) break;
        const info = page.imageinfo?.[0];
        if (info?.url && isValidEditorialImage(info.url)) {
          if (!seenUrls.has(info.url)) {
            seenUrls.add(info.url);
            validImages.push(info.url);
          }
        }
      }
      console.log(`  ↳ [Image Sourcer] Wikimedia added ${validImages.length} total valid image(s).`);
    } catch (wikiErr) {
      console.warn(`  ↳ [Image Sourcer Warning] Wikimedia fallback failed: ${wikiErr.message}`);
    }
  }

  return validImages;
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
 * Sends combined scraped text to Gemini to generate a deeply detailed SEO-optimized article.
 * Detects 'Net Worth' topic type and injects structured formatting rules accordingly.
 * @param {string} topicTitle - The name/title of the trending topic
 * @param {string} scrapedText - Combined text scraped from associated articles
 * @param {string} [topicType] - Optional topic type hint ('net_worth' triggers table/bullet formatting)
 * @returns {Promise<string>} The generated response text from Gemini
 */
async function generateArticles(topicTitle, scrapedText, topicType = 'news') {
  // ── Net Worth Detection ──
  const isNetWorth = topicType === 'net_worth' ||
    /net\s*worth|salary|earnings|income|how\s*much.*make/i.test(topicTitle);

  // ── Conditional Net Worth Formatting Block ──
  const netWorthFormattingBlock = isNetWorth ? `
- ⚠️ NET WORTH ARTICLE — STRICT FORMATTING RULES (ZERO TOLERANCE):
  This topic is a dedicated Net Worth / Lifestyle article. You MUST follow these rules with ZERO exceptions:
  1. ABSOLUTELY NO DENSE PARAGRAPHS for financial breakdowns. Every financial figure MUST live inside a structured element.
  2. Use a premium styled HTML Table (with the premium table CSS specified below) to display:
     - Income Sources Breakdown (e.g., Salary, Endorsements, Business Ventures, Investments)
     - Year-by-Year Net Worth Growth (columns: Year | Estimated Net Worth | Key Event)
     - Asset Breakdown (Real Estate, Vehicles, Investments value)
  3. Use structured HTML bullet points (<ul><li>) for:
     - Car Collection (make, model, estimated value per vehicle)
     - Real Estate Portfolio (property name, location, estimated value)
     - Brand Endorsement Deals (brand name, deal value, duration)
     - Lifestyle Highlights (private jets, yachts, watches, fashion)
  4. Keep every section HIGHLY SCANNABLE — use <h3> sub-headings liberally (e.g., 'Car Collection', 'Real Estate Empire', 'Endorsement Deals').
  5. The article MUST feel like a premium Forbes/Celebrity Net Worth breakdown, NOT a generic biography.
  6. Include at least TWO premium styled HTML tables in the article.
  7. Add a 'Quick Net Worth Snapshot' box right after the Key Takeaways using: <div style="background-color: #f8f9fa; border-left: 4px solid #0056b3; padding: 15px; margin-bottom: 20px; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); color: #333;"><h2 style="color: #0056b3; margin-top: 0; font-size: 1.2em;">Quick Net Worth Snapshot</h2><table style="width: 100%; border-collapse: collapse; text-align: left;"><tbody>TABLE_ROWS_HERE_WITH_TH_AND_TD</tbody></table></div> with rows for: Full Name, Net Worth (2026 est.), Primary Income Source, Nationality, and Age. Do NOT use bullet points here.
` : '';

  // ── PAA-Style FAQ Block (Always Active) ──
  const faqBlock = `- FAQ SECTION — 'PEOPLE ALSO ASK' OPTIMIZATION (Schema-Ready):
  You MUST include a dedicated FAQ section as the SECOND TO LAST section (before the final conclusion H2).
  Use this exact HTML structure for FAQPage Schema integration:
  <h2>People Also Ask</h2>
  Followed by 4-5 question-answer pairs. Each pair MUST use:
  <div itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">
    <h3 itemprop="name">[THE QUESTION]</h3>
    <div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">
      <p itemprop="text">[THE ANSWER - 2-3 sentences, direct and factual]</p>
    </div>
  </div>
  CRITICAL FAQ RULES:
  - Questions MUST mirror REAL US user search intent and Google 'People Also Ask' patterns.
  - Use hyper-specific, long-tail question formats that real Americans type into Google.
  ${isNetWorth ? `- For this Net Worth article, use questions like: 'How much does [Person] make per [game/movie/episode]?', 'What is [Person]\'s most expensive car?', 'How much did [Person] pay for their mansion?', 'What brands does [Person] endorse?', 'Is [Person] richer than [comparable person]?'` : `- For this news article, use questions like: 'What happened with [topic] today?', 'Why is [person/event] trending right now?', 'How does this affect [related context]?', 'When is [upcoming related event]?'`}
  - NEVER use generic questions. Every question must be answerable with a specific fact from the article.
  - The entire FAQ section MUST be wrapped in: <div itemscope itemtype="https://schema.org/FAQPage">...</div>`;

  // ── Learned SEO Rules (Self-Learning Loop) ──
  let learnedSeoRulesBlock = '';
  const seoMemoryFile = 'seo_memory.txt';
  if (fs.existsSync(seoMemoryFile)) {
    try {
      const memoryContent = fs.readFileSync(seoMemoryFile, 'utf8').trim();
      if (memoryContent) {
        const formattedRules = memoryContent
          .split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#'))
          .map(l => `  * ${l}`)
          .join('\n');

        if (formattedRules) {
          learnedSeoRulesBlock = `
- 🧠 STRICT LEARNED RULES (CONTINUOUS LEARNING LOOP FROM RECENT AUDITS — ZERO TOLERANCE):
  These rules were extracted directly from real Google Search Console performance and historical audit data. You MUST obey every single rule below to prevent past ranking penalties:
${formattedRules}
`;
        }
      }
    } catch (memErr) {
      console.warn(`[SEO Memory Warning] Failed to read ${seoMemoryFile}: ${memErr.message}`);
    }
  }

  const prompt = `You are an award-winning Senior Journalist, Elite Copywriter, and SEO Strategist for a top-tier US entertainment and sports media brand. Your single goal is to write PREMIUM, deeply researched, magazine-quality content that earns 2000+ word counts, high dwell time, and dominates Google AI Overviews and Perplexity citations.
I have scraped news about the trending topic: "${topicTitle}". Extracted text:
${scrapedText}

Write a high-quality, deeply detailed ${isNetWorth ? 'Net Worth & Lifestyle breakdown' : 'news'} article based on the provided text.

STRICT INSTRUCTIONS:${learnedSeoRulesBlock}
- PROFESSIONAL TONE & FORMATTING: Do NOT use emojis (like ⚡, 💰) in headings, summary boxes, or anywhere in the article. Keep the tone strictly professional and journalistic.
- BACKLINKO PRIMARY KEYWORD IDENTIFICATION (Step 1 — Do This FIRST): Analyze the topic and extract a clear 2-4 word primary target keyword that real US users would type into Google. This is your focus_keyword. Examples: 'LeBron James Net Worth', 'Taylor Swift Boyfriend', 'NFL Draft 2026', 'Patrick Mahomes Contract'. The keyword MUST be specific enough to target a real search query, NOT generic.
- FRONT-LOADED KEYWORD PLACEMENT (Backlinko Rule #3): You MUST place the EXACT primary focus_keyword within the FIRST 50-100 words of the opening section. Google puts more weight on terms that appear at the top of your page. This is non-negotiable.
- Forced Exact String Match (Zero Tolerance): You MUST use this EXACT focus_keyword string, character-for-character, in:
  1. title: MUST contain a Number (e.g., 5, 7) and a Power Word (e.g., Shocking, Massive, Ultimate). The title MUST strictly start with the exact focus_keyword, followed by a colon (:). Example Format: '[Focus Keyword]: 7 [Power Word] Secrets Behind This [Sentiment Word] Event'. The title tag is the MOST important place for your keyword (Backlinko Rule #4).
  2. seo_description: The very first words of this description MUST be the exact focus_keyword. The description MUST be strictly between 120 and 160 characters long. Write it to MAXIMIZE click-through rate (CTR) — use curiosity, numbers, or emotional triggers. This is your ad copy in the SERPs (Backlinko Rule #10 & #15).
  3. slug: The URL slug MUST be the exact focus_keyword (lowercase, hyphenated). Keep it SHORT and keyword-focused. Example: 'lebron-james-net-worth' NOT 'lebron-james-net-worth-2026-complete-salary-breakdown'. (Backlinko Rule #2).
  4. content: Ensure the exact focus_keyword appears naturally in the very FIRST SENTENCE of the HTML content (First 50-100 words rule).
- HEADING KEYWORD HIERARCHY (Backlinko Rule #5): The primary focus_keyword or its direct synonym MUST appear in AT LEAST ONE <h2> heading. Additionally, use the focus_keyword or a close variation in the page's conceptual H1 (the title). H tags reinforce topic relevance to Google.
- LSI & SEMANTIC KEYWORD WEAVING (Backlinko Rule #9): You MUST identify and naturally weave 3-5 LSI (Latent Semantic Indexing) keywords and semantic variations of the focus_keyword throughout the article paragraphs. For example, if focus_keyword is 'LeBron James Net Worth', LSI keywords could be: 'LeBron earnings', 'LeBron salary breakdown', 'James financial empire', 'LeBron endorsement deals', 'Lakers star wealth'. Return these as a JSON array named lsi_keywords. Do NOT stuff them — they must read naturally.
- Content Expansion Blueprint (STRICT 2000+ WORDS MINIMUM): CRITICAL SEO RULE: You MUST write a comprehensive, deeply researched, magazine-quality article that is STRICTLY OVER 2000 words long. This is non-negotiable. To hit this target, you MUST: (a) Include background context and history. (b) Add unique angles, insider facts, and data that competitors are NOT covering. (c) Explore multiple perspectives on the story. You MUST structure the HTML with exactly 5 to 6 distinct <h2> headings. Under EACH <h2> heading, you MUST write at least 4-6 detailed paragraphs or use <h3> sub-sections with supporting evidence.
- DEEP-DIVE EXPERT ANALYSIS: Under at least 2 of your <h2> sections, you MUST include an 'Expert Take' or 'By The Numbers' angle — a paragraph that synthesizes specific statistics, historical context, or a unique expert perspective that the average reader cannot find on a basic news site. This is your content's competitive moat.
- KEY TAKEAWAYS BOX: At the very top of the content (before the first paragraph), inject a styled HTML 'Key Takeaways' box using this exact template: <div style="background-color: #f8f9fa; border-left: 4px solid #0056b3; padding: 15px; margin-bottom: 20px; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); color: #333;"><h2 style="color: #0056b3; margin-top: 0; font-size: 1.2em; text-transform: uppercase; letter-spacing: 1px;">Key Takeaways</h2><table style="width: 100%; border-collapse: collapse; text-align: left;"><tbody>TABLE_ROWS_HERE_WITH_TD</tbody></table></div>. Generate 3-5 rows summarizing the most shocking/important facts of the article. Do NOT use bullet points. This increases dwell time and reduces bounce rate.
${netWorthFormattingBlock}
${faqBlock}
- Keyword Density Enforcer: Maintain a natural keyword density of strictly 1% to 1.5%.
- EXTERNAL AUTHORITY LINKS (Backlinko Rule #8 — UPGRADED): Embed exactly 2 to 3 CONTEXTUAL external links to high-authority, reputable sites using DESCRIPTIVE anchor text (NOT 'click here' or bare URLs). Link to sources like ESPN, Forbes, Wikipedia, official league sites, IMDb, or verified celebrity profiles. Each external link MUST use anchor text that describes the destination (e.g., <a href="https://www.espn.com/nfl/story/...">ESPN's analysis of the NFL trade deadline</a>). This helps Google understand your page's topic (Backlinko Rule #8). The generated HTML must also contain at least 3 internal links to https://brightcelebrity.com/ with varied, keyword-rich anchor text (Backlinko Rule #7). Bold the focus keyword at least twice.
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
  ${isNetWorth ? `[QUICK NET WORTH SNAPSHOT BOX] -> Place the styled snapshot <div> here, right after Key Takeaways.` : ``}
  Introduction: 2-3 short paragraphs containing the exact focus keyword in the first sentence.
  H2: [Catchy Section Title with Focus Keyword] -> Followed by detailed paragraphs with deep analysis.
  H3: [Sub-topic] -> Followed by bullet points or expert insights.
  H2: [Data/Stats Section Title] -> Followed by the newly styled premium HTML table.
  ${isNetWorth ? `H2: [Income Sources & Earnings Breakdown] -> Premium HTML table with all income streams.
  H2: [Car Collection & Real Estate] -> Structured bullet points for assets.
  H2: [Brand Endorsements & Business Ventures] -> Bullet points with deal values.` : `H2: [Background & Context] -> Deep-dive history, expert take, or 'By The Numbers' section.`}
  H2: People Also Ask -> 4-5 Schema.org structured Q&A pairs (FAQPage schema-ready).
  H2: [Final Thoughts / Conclusion] -> Summarize and naturally include the focus keyword one last time.
- Meaningful Lists: Use bullet points (<ul>) or numbered lists (<ol>) ONLY when breaking down complex ideas, itemizing facts, or listing achievements. Do not use them just for the sake of having a list.
- Smart Image Placement & MULTI-IMAGE ALT TAGS: You must dynamically and organically insert exactly TWO image placeholders: [INJECT_IMAGE_2_HERE] and [INJECT_IMAGE_3_HERE] evenly throughout the HTML content. Place the first one after the first or second <h2> tag, and the second one further down the article. Do NOT use generic <img> tags, ONLY use the exact string placeholders.
- KEYWORD-RICH IMAGE ALT TEXT (Backlinko Rule #6): You must generate a JSON array named body_image_alt_tags containing exactly 2 strings. Each alt tag MUST be a highly descriptive, keyword-rich phrase that includes the primary focus_keyword and describes what the image likely shows. Example: 'LeBron James celebrating after scoring 40 points in Lakers game 2026' NOT 'image1'. Google uses image alt text to understand page content.
- Also generate a JSON string named featured_image_alt — a descriptive alt text for the featured/thumbnail image containing the focus_keyword. Example: 'Patrick Mahomes throwing a touchdown pass during 2026 NFL season'.
- Courtesy (Tone): Maintain a highly helpful, engaging, and welcoming tone.
- Tags: Generate a JSON array named tags containing exactly 15 to 20 highly specific, long-tail SEO tags relevant to the article. Mix entity names, trending search queries (like 'Net Worth 2026'), associated people, and specific events. Do NOT use generic one-word tags. Integrate these naturally into the body text.
- Category: Analyze the article and return TWO category fields: parent_category (string, e.g., 'Sports', 'Entertainment') and sub_categories (An ARRAY of strings). You MUST dynamically decide how many sub-categories are relevant.
- Slug: Generate a slug that is the focus_keyword converted to lowercase, hyphen-separated. Keep it SHORT — just the keyword. Example: 'lebron-james-net-worth'. Do NOT add extra words beyond the keyword.
- Thumbnail Text: Generate a short, highly engaging text specifically for an image overlay. It MUST be extremely short: Maximum 3 to 5 words. It MUST be highly engaging, clickbaity, and use a power word (e.g., 'Shocking Truth Revealed!', 'Must See Details!', 'Hidden Secrets!'). It should summarize the core emotion or shock-value of the article.

CRITICAL OUTPUT REQUIREMENT: You MUST return ONLY valid JSON formatted strictly as follows, without any markdown backticks, explanations, or extra text. NEVER use literal \n or \r characters in the content string. Use proper HTML tags like <p> and <br> for spacing:
{
  "title": "Simple direct headline",
  "content": "Full HTML article body text following the formatting rules...",
  "parent_category": "Broad Category (e.g., Sports, Entertainment)",
  "sub_categories": ["Sub-category 1", "Sub-category 2"],
  "focus_keyword": "2-4 word primary target keyword",
  "lsi_keywords": ["semantic variation 1", "LSI keyword 2", "related phrase 3", "synonym 4", "contextual term 5"],
  "slug": "short-keyword-slug",
  "tags": ["Highly Specific Tag 1", "Person Net Worth 2026", "Associated Event 2026", "Trending Search Query 4"],
  "seo_description": "A compelling 120-160 char meta description engineered for maximum CTR",
  "thumbnail_text": "Shocking Truth Revealed!",
  "body_image_alt_tags": ["descriptive keyword-rich alt text for image 1", "descriptive keyword-rich alt text for image 2"],
  "featured_image_alt": "descriptive keyword-rich alt text for the featured thumbnail image",
  "primary_subject_name": "Full Name of the main person in the article, or null if not about a specific person"
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
 * Fetches raw trending US Sports and Entertainment news from NewsData.io API.
 * Returns unsliced filtered arrays for downstream curation.
 * @returns {Promise<{sportsFiltered: Array, entFiltered: Array}>}
 */
async function fetchRawUSNewsTrends() {
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

    const sportsFiltered = sportsResults.filter(item => item && isValidEditorialImage(item.image_url));
    const entFiltered = entResults.filter(item => item && isValidEditorialImage(item.image_url));

    console.log(`[Info] Raw fetch: ${sportsFiltered.length} valid Sports, ${entFiltered.length} valid Entertainment articles.`);
    return { sportsFiltered, entFiltered };
  } catch (error) {
    const errMsg = error.response?.data?.results?.message || error.response?.data?.message || error.message;
    console.error(`[Error] Failed to fetch NewsData.io API: ${errMsg}`);
    return { sportsFiltered: [], entFiltered: [] };
  }
}

/**
 * Uses Gemini to identify the single most trending US person from a list of news headlines.
 * @param {Array} newsItems - Array of news article objects with 'title' and 'snippet' fields
 * @param {string} domain - Either 'sports' or 'entertainment'
 * @returns {Promise<string>} The full name of the top trending person
 */
async function identifyTopTrendingPerson(newsItems, domain) {
  const headlines = newsItems.map(item => `- ${item.title}`).join('\n');
  const prompt = `You are an expert US ${domain} analyst. Analyze these trending US ${domain} headlines and identify the SINGLE most talked-about, trending American ${domain === 'sports' ? 'athlete/sports personality' : 'celebrity/entertainer'} right now.

Headlines:
${headlines}

Rules:
- Pick ONLY ONE person who is generating the MOST buzz across these headlines.
- The person MUST be a well-known US-based figure.
- If no clear person emerges, pick the most famous ${domain === 'sports' ? 'US athlete (e.g., LeBron James, Patrick Mahomes, Travis Kelce)' : 'US celebrity (e.g., Taylor Swift, Zendaya, MrBeast, Beyoncé)'}.
- Return ONLY the person's full name as a plain string. No quotes, no explanation, no JSON.

Example output: LeBron James`;

  try {
    const result = await geminiModel.generateContent(prompt);
    const personName = result.response.text().trim().replace(/["']/g, '');
    console.log(`[Curate] Top trending ${domain} person identified: ${personName}`);
    return personName;
  } catch (err) {
    const fallback = domain === 'sports' ? 'LeBron James' : 'Taylor Swift';
    console.warn(`[Curate] Failed to identify trending ${domain} person (${err.message}). Falling back to: ${fallback}`);
    return fallback;
  }
}

/**
 * Curates a strict batch of 10 topics following the 4+1+4+1 content mix strategy:
 *   4 Trending US Sports News
 *   1 Sports Person Net Worth/Lifestyle
 *   4 Trending US Entertainment News
 *   1 Celebrity Net Worth/Lifestyle
 * @returns {Promise<Array<{title: string, link: string, snippet: string, image_url: string, category: string, topicType: string}>>}
 */
async function curateTenTopicBatch() {
  console.log('[Curate] Starting 4+1+4+1 US content mix curation...');

  const { sportsFiltered, entFiltered } = await fetchRawUSNewsTrends();

  // ── Extract 4 Sports News topics ──
  const sportsNews = sportsFiltered.slice(0, 4).map(item => ({
    title: item.title || 'Unknown Sports Topic',
    link: item.link || '',
    snippet: item.description || item.content || item.title,
    image_url: item.image_url,
    category: 'sports',
    topicType: 'news'
  }));

  // ── Extract 4 Entertainment News topics ──
  const entNews = entFiltered.slice(0, 4).map(item => ({
    title: item.title || 'Unknown Entertainment Topic',
    link: item.link || '',
    snippet: item.description || item.content || item.title,
    image_url: item.image_url,
    category: 'entertainment',
    topicType: 'news'
  }));

  // ── Identify top trending persons via Gemini (parallel) ──
  const [sportsPersonName, entPersonName] = await Promise.all([
    identifyTopTrendingPerson(sportsFiltered.slice(0, 10), 'sports'),
    identifyTopTrendingPerson(entFiltered.slice(0, 10), 'entertainment')
  ]);

  // ── Create 1 Sports Net Worth topic ──
  const sportsNetWorth = {
    title: `${sportsPersonName} Net Worth 2026: Complete Salary, Endorsements & Lifestyle Breakdown`,
    link: '',
    snippet: `Comprehensive net worth breakdown of ${sportsPersonName} including salary, endorsement deals, car collection, real estate portfolio, business ventures, and complete lifestyle analysis for 2026.`,
    image_url: sportsFiltered[0]?.image_url || '',
    category: 'sports',
    topicType: 'net_worth'
  };

  // ── Create 1 Entertainment Net Worth topic ──
  const entNetWorth = {
    title: `${entPersonName} Net Worth 2026: Complete Earnings, Assets & Lifestyle Breakdown`,
    link: '',
    snippet: `Comprehensive net worth breakdown of ${entPersonName} including earnings, brand deals, car collection, real estate portfolio, business empire, and complete lifestyle analysis for 2026.`,
    image_url: entFiltered[0]?.image_url || '',
    category: 'entertainment',
    topicType: 'net_worth'
  };

  // ── Assemble the final 10-topic batch (4+1+4+1) ──
  const batch = [
    ...sportsNews,
    sportsNetWorth,
    ...entNews,
    entNetWorth
  ];

  console.log(`[Curate] ✅ Curated ${batch.length} topics:`);
  console.log(`  → ${sportsNews.length} Sports News`);
  console.log(`  → 1 Sports Net Worth: "${sportsPersonName}"`);
  console.log(`  → ${entNews.length} Entertainment News`);
  console.log(`  → 1 Entertainment Net Worth: "${entPersonName}"`);

  return batch;
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
  console.log(`[Topic Process ${index}] Processing: "${item.title}" (type: ${item.topicType || 'news'})`);
  
  try {
    // Net worth topics may not have a source link — use snippet as seed content
    if (!item.link && item.topicType !== 'net_worth') {
      console.log(`  ↳ [Topic ${index}] Skipped: No valid source URL.`);
      return null;
    }

    let rawText = item.snippet || item.title;
    let scraped = { wordCount: 0, text: '', status: 'No source URL', image1: '', bodyImages: [] };

    if (item.link) {
      console.log(`  ↳ [Topic ${index}] Scraping source URL via Cheerio...`);
      scraped = await scrapeArticleText(item.link);
      console.log(`  ↳ [Topic ${index}] Scraped ${scraped.wordCount} words (${scraped.status}).`);
      if (scraped.wordCount > 0 && scraped.text) {
        rawText = scraped.text;
      }
    } else {
      console.log(`  ↳ [Topic ${index}] Net Worth topic — using AI knowledge + snippet as seed.`);
    }

    const combinedText = `--- ARTICLE: ${item.title} (${item.link || 'AI-generated topic'}) ---\n${rawText}`;
    
    console.log(`  ↳ [Topic ${index}] Generating SEO article via Gemini AI...`);
    console.log("Step 3: Generating Article with Gemini AI...");
    const generatedOutput = await generateArticles(item.title, combinedText, item.topicType || 'news');

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

    // ── Entity-Based Image Sourcing ──
    // If Gemini identified a primary subject (person), fetch REAL photos from DuckDuckGo
    const primarySubject = parsedGemini?.primary_subject_name || null;
    let realImages = [];

    if (primarySubject && typeof primarySubject === 'string' && primarySubject.toLowerCase() !== 'null') {
      console.log(`  ↳ [Topic ${index}] Entity detected: "${primarySubject}". Fetching real subject images...`);
      realImages = await fetchRealSubjectImages(primarySubject, 4);
    }

    // Determine final image sources: prefer real entity images over generic NewsData images
    const finalFeaturedImage = realImages.length > 0
      ? realImages[0]
      : getHighResImageUrl(item.image_url || '');

    const finalBodyImages = realImages.length >= 3
      ? realImages.slice(1, 3)
      : (scraped.wordCount > 0 && Array.isArray(scraped.bodyImages) && scraped.bodyImages.length > 0)
        ? scraped.bodyImages
        : [getHighResImageUrl(item.image_url)];

    // Structure into the final result object
    const topicResult = {
      topic: item.title,
      title: parsedGemini?.title || `${item.title}`,
      content: parsedGemini?.content || '',
      image1: finalFeaturedImage,
      bodyImages: finalBodyImages,
      bodyImageAltTags: Array.isArray(parsedGemini?.body_image_alt_tags) ? parsedGemini.body_image_alt_tags : [],
      featuredImageAlt: parsedGemini?.featured_image_alt || `${parsedGemini?.focus_keyword || item.title} - latest news and updates`,
      parent_category: parentCategory,
      sub_categories: subCategories,
      topicType: item.category || 'sports',
      focus_keyword: parsedGemini?.focus_keyword || item.title,
      lsi_keywords: Array.isArray(parsedGemini?.lsi_keywords) ? parsedGemini.lsi_keywords : [],
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

    console.log("Step 2: Curating 4+1+4+1 US Content Mix...");
    const curatedBatch = await curateTenTopicBatch();
    
    // Deduplicate news topics (net worth topics are always unique by design)
    const newsTopics = curatedBatch.filter(t => t.topicType === 'news');
    const netWorthTopics = curatedBatch.filter(t => t.topicType === 'net_worth');
    const dedupedNews = deduplicateTopics(newsTopics);
    
    // Reassemble: deduped news + net worth topics (always kept)
    const topTopics = [...dedupedNews, ...netWorthTopics];

    if (topTopics.length === 0) {
      console.log('[Info] No trending topics found. Exiting.');
      return;
    }

    console.log(`\n[Info] Starting ultra-fast parallel generation pipeline for ${topTopics.length} topics (4+1+4+1 mix)...\n`);
    const publishQueue = [];  // Articles that passed validation
    const retryQueue = [];    // { item, index } objects that failed validation
    const BATCH_SIZE = 5; // Process 5 at a time (half the batch) to balance speed vs API limits

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
          fs.appendFileSync('latest_url.txt', wpResponse.link + '\n');
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
                fs.appendFileSync('latest_url.txt', wpResponse.link + '\n');
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
    const wpEndpoint = `${process.env.WP_URL.replace(/\/$/, '')}/wp-json/wp/v2/media`;

    const form = new FormData();
    // Backlinko Rule #6: Use keyword-rich image filenames
    const keywordSlug = (altText || title || 'image').replace(/[^a-z0-9]/gi, '-').replace(/(^-|-$)+/g, '').replace(/-{2,}/g, '-').toLowerCase();
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

    // Upload image to WordPress Media Library (Backlinko Rule #6: keyword-rich alt text)
    let mediaId = null;
    if (article.image1) {
      const featuredAlt = article.featuredImageAlt || `${article.focus_keyword} - latest news and updates`;
      mediaId = await uploadImageToWordPress(article.image1, article.title, featuredAlt, article.thumbnail_text);
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

    // Backlinko Rule #2: Derive slug from focus_keyword for clean, keyword-targeted URLs
    // e.g., 'LeBron James Net Worth' -> 'lebron-james-net-worth'
    const keywordForSlug = article.focus_keyword || article.title || 'article';
    let seoSlug = keywordForSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
    // If Gemini already returned a clean short slug, prefer it
    if (article.slug && article.slug.length > 3 && article.slug.length < 60) {
      seoSlug = article.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-|-$)+/g, '');
    }
    if (seoSlug.length > 60) {
      seoSlug = seoSlug.substring(0, 60).replace(/-+$/, '');
    }

    // Backlinko Rule #10: Ensure meta description is <=160 chars and CTR-optimized
    let metaExcerpt = (article.seo_description || '').trim();
    if (metaExcerpt.length > 160) {
      metaExcerpt = metaExcerpt.substring(0, 157).replace(/\s+\S*$/, '') + '...';
    }

    const payload = {
      title: article.title || 'Untitled Article',
      content: postContent,
      excerpt: metaExcerpt,
      status: 'publish',
      categories: categoryIds,
      tags: tagIds,
      slug: seoSlug,
      meta: {
        rank_math_focus_keyword: article.focus_keyword || '',
        rank_math_description: metaExcerpt,
        rank_math_title: article.title || '',
        rank_math_content_ai_score: '100'
      }
    };

    if (mediaId) {
      payload.featured_media = mediaId;
    }

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
    throw new Error(errDetail);
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
