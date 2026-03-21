import OpenAI from 'openai';
import path from 'path';
import fs from 'fs';
import os from 'os';

const getOpenAI = () => new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// All site pages for internal linking
const SITE_PAGES = [
  { path: '/', title: 'Hlavní stránka' },
  { path: '/book', title: 'Online rezervace' },
  { path: '/cenik', title: 'Ceník služeb' },
  { path: '/kontakt', title: 'Kontakt' },
  { path: '/darkovy-voucher', title: 'Dárkový voucher' },
  { path: '/blog', title: 'Blog' },
  { path: '/service/oboci', title: 'Úprava obočí' },
  { path: '/service/rasy', title: 'Řasy' },
  { path: '/service/manikura', title: 'Manikúra' },
];

const SALON_CONTEXT = `
Barbitch je beauty salon v Brně, Česká republika (barbitch.cz).
Služby: úprava obočí (laminace, barvení, úprava pinzetou/voskem), řasy (prodloužení, lifting, lash botox), manikúra (gelové nehty, gel lak, japonská manikúra).
Cílová skupina: ženy 20-45 let v Brně, které hledají kvalitní beauty péči.
Jazyk: veškerý obsah MUSÍ být v češtině.
Tón: profesionální ale přátelský, s použitím odborných beauty termínů.
`;

// Fetch all existing blog posts from Strapi
async function getExistingPosts(): Promise<{ title: string; slug: string; keywords?: string[] }[]> {
  const blogs: any = await strapi.entityService.findMany('api::blog.blog' as any, {
    fields: ['title', 'slug'],
    populate: { metaData: { fields: ['title', 'description'] } },
    status: 'published',
    limit: 100,
  });

  const articles: any = await strapi.entityService.findMany('api::article.article' as any, {
    fields: ['title', 'slug'],
    populate: { metaData: { fields: ['title', 'description'] } },
    status: 'published',
    limit: 100,
  });

  const posts = [...(blogs || []), ...(articles || [])];
  return posts.map((p: any) => ({
    title: p.title,
    slug: p.slug,
    keywords: p.metaData?.description?.split(',').map((k: string) => k.trim()).filter(Boolean) || [],
  }));
}

// Get existing topics to avoid duplicates
async function getExistingTopics(): Promise<string[]> {
  const topics: any = await strapi.entityService.findMany('api::blog-topic.blog-topic' as any, {
    fields: ['title'],
    limit: 200,
  });
  return (topics || []).map((t: any) => t.title);
}

// Analyze existing content and generate topic suggestions
async function analyzeAndGeneratePlan(month: number, year: number) {
  const openai = getOpenAI();
  const existingPosts = await getExistingPosts();
  const existingTopics = await getExistingTopics();

  const existingPostsList = existingPosts.map(p => `- "${p.title}" (/${p.slug})`).join('\n');
  const existingTopicsList = existingTopics.map(t => `- "${t}"`).join('\n');
  const sitePagesList = SITE_PAGES.map(p => `- ${p.title} (${p.path})`).join('\n');

  const monthNames = ['', 'leden', 'únor', 'březen', 'duben', 'květen', 'červen',
    'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];

  const prompt = `${SALON_CONTEXT}

Existující články na blogu:
${existingPostsList || '(žádné)'}

Již navržená témata (neopakuj):
${existingTopicsList || '(žádná)'}

Stránky webu pro interní linking:
${sitePagesList}

Existující blogové články (VYUŽIJ pro cross-linking):
${existingPostsList || '(žádné)'}

Úkol: Navrhni 4 témata blogových článků pro měsíc ${monthNames[month]} ${year}.

Požadavky:
1. Témata musí být relevantní pro beauty salon a přivádět organický traffic z Google
2. Zohledni sezónnost (${monthNames[month]}) — jaké beauty procedury jsou v tomto období populární
3. Každé téma musí mít potenciál pro long-tail keywords
4. DŮLEŽITÉ: Každé téma MUSÍ mít 3-5 interních linků — kombinuj stránky webu (/, /cenik, /book, /kontakt, /darkovy-voucher, /service/*) I existující blogové články (/blog/slug). Čím více cross-linků mezi články, tím lépe pro SEO
5. Neopakuj existující články ani dříve navržená témata
6. Slug musí být v češtině, bez diakritiky, s pomlčkami
7. Témata by měla být vzájemně propojitelná — navrhni je tak, aby se daly mezi sebou prolinkovat

Odpověz POUZE validním JSON ve formátu:
{
  "topics": [
    {
      "title": "Název článku v češtině",
      "description": "2-3 věty popisující o čem článek bude a proč je relevantní pro SEO",
      "keywords": ["klíčové slovo 1", "klíčové slovo 2", "klíčové slovo 3", "klíčové slovo 4", "klíčové slovo 5"],
      "targetSlug": "nazev-clanku-bez-diakritiky",
      "internalLinks": ["/cenik", "/service/oboci", "/blog/existujici-clanek", "/book", "/darkovy-voucher"],
      "weekNumber": 1
    }
  ]
}

weekNumber = 1-4 (týden v měsíci kdy publikovat).`;

  const response = await openai.chat.completions.create({
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: 'Jsi SEO expert specializovaný na beauty industry v České republice. Odpovídáš POUZE validním JSON.' },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.8,
  });

  const result = JSON.parse(response.choices[0].message.content || '{"topics":[]}');
  return result.topics || [];
}

// Helper: find topic by documentId and return with numeric id
async function findTopicByDocId(documentId: string) {
  const results: any = await strapi.entityService.findMany('api::blog-topic.blog-topic' as any, {
    filters: { documentId },
    populate: { plan: true },
    limit: 1,
  });
  return Array.isArray(results) ? results[0] : null;
}

// Generate full article content with dynamic zones
async function generateArticle(topicId: string) {
  const openai = getOpenAI();

  const topic: any = await findTopicByDocId(topicId);

  if (!topic) throw new Error('Topic not found');
  if (topic.stage !== 'approved') throw new Error('Topic must be approved before generating');

  // Update status to generating
  await strapi.entityService.update('api::blog-topic.blog-topic' as any, topic.id, {
    data: { stage: 'generating' },
  });

  try {
    const existingPosts = await getExistingPosts();
    const existingPostsList = existingPosts.map(p => `- "${p.title}" (slug: ${p.slug})`).join('\n');
    const sitePagesList = SITE_PAGES.map(p => `- ${p.title}: ${p.path}`).join('\n');
    const internalLinks = (topic.internalLinks || []).map((l: string) => `- ${l}`).join('\n');

    const articlePrompt = `${SALON_CONTEXT}

Napiš kompletní blogový článek na téma: "${topic.title}"
Popis: ${topic.description}
Cílová klíčová slova: ${(topic.keywords || []).join(', ')}

Stránky webu pro interní prolinkování:
${sitePagesList}

Existující články (můžeš na ně odkazovat — VYUŽIJ pro cross-linking):
${existingPostsList || '(žádné)'}

Doporučené interní linky:
${internalLinks || '(žádné)'}

FORMÁT ODPOVĚDI — POUZE validní JSON:
{
  "metaTitle": "SEO title (max 60 znaků)",
  "metaDescription": "SEO meta description (max 155 znaků)",
  "dynamicContent": [
    {
      "__component": "content.text",
      "title": null,
      "contentText": "<p>Úvodní odstavec — hook, kontext, co čtenář získá. BEZ title (null).</p>"
    },
    {
      "__component": "content.text",
      "title": "Nadpis sekce s klíčovým slovem",
      "contentText": "<p>Obsah sekce s <strong>klíčovými pojmy</strong>, <a href='/cenik'>interními linky</a>.</p><ul><li>Položka seznamu</li></ul><h3>Podnadpis</h3><p>Další text...</p><table><thead><tr><th>Sloupec 1</th><th>Sloupec 2</th></tr></thead><tbody><tr><td>Data</td><td>Data</td></tr></tbody></table>"
    },
    {
      "__component": "content.content-baner",
      "title": "CTA text banneru",
      "cta": { "title": "Text tlačítka", "link": "/book" }
    },
    {
      "__component": "content.faq",
      "item": [
        { "title": "Otázka s long-tail keyword?", "content": "<p>Podrobná odpověď.</p>" }
      ]
    }
  ]
}

STRUKTURA ČLÁNKU (dodržuj přesně toto pořadí):
1. ÚVOD (content.text, title: null) — hook, kontext, co čtenář získá. 150-200 slov.
2. HLAVNÍ SEKCE (content.text × 4-6) — každá 200-400 slov s title (H2 nadpis s klíčovým slovem)
3. BANNER uprostřed (content.content-baner) — CTA na /book nebo relevantní službu
4. DALŠÍ SEKCE (content.text × 1-2) — pokračování obsahu
5. FAQ (content.faq) — 5-7 otázek s long-tail keywords
6. ZÁVĚR S CTA (content.text) — title: "Závěr" nebo kreativní varianta. Shrnutí + výzva k akci + odkaz na /book a /kontakt. Tón: přátelský, motivační ("Neváhejte", "Přijďte", "Rezervujte si termín")
7. BANNER na konci (content.content-baner) — finální CTA

POŽADAVKY NA OBSAH:
1. Celkem 1500-2500 slov — DŮLEŽITÉ pro SEO, Google preferuje delší, podrobné články
2. MINIMÁLNĚ 8-12 interních linků rozmístěných přirozeně v textu — kombinuj stránky webu (/cenik, /book, /service/*, /kontakt, /darkovy-voucher) I existující blogové články (/blog/slug). Cross-linking mezi články je KLÍČOVÝ pro SEO
3. Přirozená čeština bez strojového zvuku, expert tón, jako by psal zkušený beauty blogger
4. Klíčová slova: v H2 nadpisech, prvním odstavci, FAQ otázkách, meta description

FORMÁTOVÁNÍ (DŮLEŽITÉ pro SEO — structured content = vyšší šance na featured snippets):
- <ul><li> a <ol><li> — seznamy (nejméně 2-3 v článku)
- <table> — srovnávací tabulky (alespoň 1 v článku, např. "DIY vs salon", "srovnání metod", "cenové rozmezí")
- <strong> — klíčové pojmy a důležité informace
- <blockquote> — citáty nebo tipy expertů (1-2 v článku)
- <h3> — podnadpisy v delších sekcích
- <a href="..."> — interní linky s přirozeným anchor textem

INLINE OBRÁZKY (1-2 v článku):
- Vlož do contentText placeholder {{IMAGE:popis obrázku v angličtině pro DALL-E}}
- Obrázky MUSÍ být smysluplné a vysvětlující — NE jen dekorativní
- Příklady: "Close-up of eyebrow lamination process step by step", "Comparison of gel nails vs acrylic nails side by side", "Proper hand care routine illustration"
- Umísti je tam kde vizuální znázornění pomůže čtenáři pochopit text (po vysvětlení procesu, u srovnání, u návodů)
- Placeholder vlož na vlastní řádek MEZI odstavce <p>, např: <p>Text před...</p>{{IMAGE:popis}}<p>Text po...</p>
- Maximálně 2 obrázky v celém článku

BANNERY:
- CTA bannery vedou na /book (rezervace) nebo relevantní službu
- Texty: kreativní, motivační ("Rezervuj si termín", "Přijď na konzultaci", apod.)`;

    const response = await openai.chat.completions.create({
      model: 'gpt-5.4',
      messages: [
        { role: 'system', content: 'Jsi profesionální český copywriter specializovaný na beauty & wellness SEO obsah. Píšeš přirozené, poutavé články optimalizované pro Google. Odpovídáš POUZE validním JSON.' },
        { role: 'user', content: articlePrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
      max_completion_tokens: 8000,
    });

    const article = JSON.parse(response.choices[0].message.content || '{}');

    // Generate featured image with DALL-E
    let headerImage: { id: number; url: string; alt: string } | null = null;
    try {
      headerImage = await generateAndUploadImage(topic.title, topic.keywords || [], 'header');
    } catch (err) {
      strapi.log.warn('DALL-E header image generation failed, creating post without image:', err);
    }

    // Generate inline content images (replaces {{IMAGE:...}} placeholders)
    let dynamicContent = article.dynamicContent || [];
    try {
      dynamicContent = await generateContentImages(dynamicContent, topic.title, topic.keywords || []);
    } catch (err) {
      strapi.log.warn('Content image generation failed, continuing without inline images:', err);
    }

    // Inject header image into banner components
    dynamicContent = dynamicContent.map((component: any) => {
      if (component.__component === 'content.content-baner' && headerImage) {
        return { ...component, image: headerImage.id };
      }
      return component;
    });

    // Create blog post as draft in Strapi
    const blogData: any = {
      title: topic.title,
      slug: topic.targetSlug,
      metaData: {
        title: article.metaTitle || topic.title,
        description: article.metaDescription || topic.description,
        ...(headerImage ? { image: headerImage.id } : {}),
      },
      dynamicContent,
    };

    if (headerImage) {
      blogData.image = headerImage.id;
    }

    const blogPost: any = await strapi.entityService.create('api::blog.blog' as any, {
      data: blogData,
      status: 'draft',
    });

    // Update topic status and link to blog post
    await strapi.entityService.update('api::blog-topic.blog-topic' as any, topic.id, {
      data: {
        stage: 'generated',
        blog: blogPost.documentId,
      },
    });

    return {
      blogPost: {
        id: blogPost.id,
        documentId: blogPost.documentId,
        title: blogPost.title,
        slug: blogPost.slug,
      },
      article,
    };
  } catch (err) {
    // Revert status on failure
    await strapi.entityService.update('api::blog-topic.blog-topic' as any, topic.id, {
      data: { stage: 'approved' },
    });
    throw err;
  }
}

// Generate contextual inline images for article content
async function generateContentImages(
  dynamicContent: any[],
  title: string,
  keywords: string[]
): Promise<any[]> {
  // Find placeholders like {{IMAGE:description of what to generate}}
  const imagePattern = /\{\{IMAGE:([^}]+)\}\}/g;
  const imagesToGenerate: { componentIdx: number; placeholder: string; description: string }[] = [];

  dynamicContent.forEach((component, idx) => {
    if (component.__component === 'content.text' && component.contentText) {
      let match;
      while ((match = imagePattern.exec(component.contentText)) !== null) {
        imagesToGenerate.push({
          componentIdx: idx,
          placeholder: match[0],
          description: match[1].trim(),
        });
      }
    }
  });

  if (imagesToGenerate.length === 0) return dynamicContent;

  strapi.log.info(`Generating ${imagesToGenerate.length} inline content image(s)...`);

  // Generate images (max 2 to keep costs reasonable)
  const toGenerate = imagesToGenerate.slice(0, 2);
  const results = await Promise.allSettled(
    toGenerate.map(async (img) => {
      const uploaded = await generateAndUploadImage(
        img.description,
        keywords,
        'content'
      );
      return { ...img, uploaded };
    })
  );

  // Replace placeholders with <img> tags
  const updatedContent = [...dynamicContent];
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { componentIdx, placeholder, uploaded } = result.value;
    const component = updatedContent[componentIdx];
    const imgTag = `<figure class="content-image"><img src="${uploaded.url}" alt="${uploaded.alt}" width="896" height="512" loading="lazy" /><figcaption>${uploaded.alt}</figcaption></figure>`;
    component.contentText = component.contentText.replace(placeholder, imgTag);
  }

  // Clean up any remaining ungenerated placeholders
  for (const component of updatedContent) {
    if (component.__component === 'content.text' && component.contentText) {
      component.contentText = component.contentText.replace(/\{\{IMAGE:[^}]+\}\}/g, '');
    }
  }

  return updatedContent;
}

// Generate image with DALL-E and upload to Strapi media library
async function generateAndUploadImage(
  title: string,
  keywords: string[],
  type: 'header' | 'content' = 'header'
): Promise<{ id: number; url: string; alt: string }> {
  const openai = getOpenAI();

  const styleByType = type === 'content'
    ? 'Informative illustration that visually explains the concept. Clean, educational, modern style. Not just decorative — should help the reader understand the topic.'
    : 'Modern, clean, soft pastel colors, professional beauty photography aesthetic. High quality, editorial style.';

  const sizeByType = type === 'content' ? '1024x1024' as const : '1792x1024' as const;

  const imagePrompt = `Professional beauty salon blog image. Theme: "${title}". Style: ${styleByType} Keywords: ${keywords.slice(0, 3).join(', ')}. No text on image.`;

  const imageResponse = await openai.images.generate({
    model: 'dall-e-3',
    prompt: imagePrompt,
    n: 1,
    size: sizeByType,
    quality: 'standard',
  });

  const imageUrl = imageResponse.data[0]?.url;
  if (!imageUrl) throw new Error('No image URL from DALL-E');

  // Download image using native fetch (Node 22)
  const imgResponse = await fetch(imageUrl);
  const arrayBuffer = await imgResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Create a slug-safe filename
  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const filename = `blog-${slug}.png`;

  // Write to temp file for Strapi upload
  const tmpPath = path.join(os.tmpdir(), filename);
  fs.writeFileSync(tmpPath, buffer);

  try {
    // Upload to Strapi media library (Strapi 5 format)
    const fileStats = fs.statSync(tmpPath);
    const uploadedFiles = await (strapi as any).plugins.upload.services.upload.upload({
      data: {
        fileInfo: {
          name: `blog-${slug}`,
          alternativeText: title,
        },
      },
      files: {
        filepath: tmpPath,
        originalFilename: filename,
        mimetype: 'image/png',
        size: fileStats.size,
      },
    });

    if (!uploadedFiles || uploadedFiles.length === 0) {
      throw new Error('Failed to upload image to Strapi');
    }

    const file = uploadedFiles[0];
    return { id: file.id, url: file.url, alt: title };
  } catch (uploadErr) {
    // Fallback: try alternative upload format
    strapi.log.warn('Primary upload failed, trying fallback:', uploadErr);
    try {
      const uploadedFiles = await (strapi as any).plugins.upload.services.upload.upload({
        data: {
          fileInfo: {
            name: `blog-${slug}`,
            alternativeText: title,
          },
        },
        files: {
          path: tmpPath,
          name: filename,
          type: 'image/png',
          size: buffer.length,
        },
      });

      if (!uploadedFiles || uploadedFiles.length === 0) {
        throw new Error('Failed to upload image to Strapi (fallback)');
      }

      const file = uploadedFiles[0];
      return { id: file.id, url: file.url, alt: title };
    } catch (fallbackErr) {
      strapi.log.error('Both upload methods failed:', fallbackErr);
      throw fallbackErr;
    }
  } finally {
    // Cleanup temp file
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

export default {
  analyzeAndGeneratePlan,
  generateArticle,
  getExistingPosts,
};
