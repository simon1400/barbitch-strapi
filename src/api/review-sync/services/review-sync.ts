// @ts-nocheck

const GOOGLE_PLACE_ID = process.env.GOOGLE_PLACE_ID;

async function fetchGoogleReviewsBatch(sort: string): Promise<any[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_API;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY is not set');
  }
  if (!GOOGLE_PLACE_ID) {
    throw new Error('GOOGLE_PLACE_ID is not set');
  }

  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${GOOGLE_PLACE_ID}&fields=reviews&reviews_sort=${sort}&key=${apiKey}`;

  const response = await fetch(url);
  const data = await response.json();

  if (data.status !== 'OK') {
    throw new Error(`Google Places API error: ${data.status} — ${data.error_message || ''}`);
  }

  return data.result?.reviews || [];
}

async function fetchGoogleReviews(): Promise<any[]> {
  const [newest, relevant] = await Promise.all([
    fetchGoogleReviewsBatch('newest'),
    fetchGoogleReviewsBatch('most_relevant'),
  ]);

  const seen = new Set<string>();
  const all: any[] = [];

  for (const review of [...newest, ...relevant]) {
    const key = `${review.author_name}_${review.time}`;
    if (!seen.has(key)) {
      seen.add(key);
      all.push(review);
    }
  }

  return all;
}

function generateReviewId(review: any): string {
  return `${review.author_name}_${review.time}`;
}

export default {
  async syncReviews() {
    const googleReviews = await fetchGoogleReviews();
    let created = 0;
    let skipped = 0;
    let filtered = 0;

    for (const review of googleReviews) {
      // Only positive reviews (4-5 stars) with text
      if (review.rating < 4 || !review.text?.trim()) {
        filtered++;
        continue;
      }

      const googleReviewId = generateReviewId(review);

      // Check if already exists
      const existing = await strapi.entityService.findMany('api::google-review.google-review', {
        filters: { googleReviewId },
        limit: 1,
      });

      if (existing && (existing as any[]).length > 0) {
        skipped++;
        continue;
      }

      await strapi.entityService.create('api::google-review.google-review', {
        data: {
          reviewerName: review.author_name,
          reviewerPhoto: review.profile_photo_url || '',
          rating: review.rating,
          comment: review.text,
          googleReviewId,
          reviewDate: review.relative_time_description || '',
        },
      });
      created++;
    }

    return { created, skipped, filtered, total: googleReviews.length };
  },
};
