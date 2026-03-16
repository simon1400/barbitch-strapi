// @ts-nocheck — content type UIDs are generated at build time, runtime discovery works fine

// Helper: find topic by documentId
async function findTopic(documentId: string) {
  const results = await strapi.entityService.findMany('api::blog-topic.blog-topic', {
    filters: { documentId },
    limit: 1,
  });
  return Array.isArray(results) ? results[0] : null;
}

// Helper: update topic by documentId
async function updateTopicStatus(documentId: string, data: any) {
  const topic = await findTopic(documentId);
  if (!topic) return null;
  return strapi.entityService.update('api::blog-topic.blog-topic', topic.id, { data });
}

export default {
  // POST /api/blog-ai/generate-plan
  async generatePlan(ctx) {
    try {
      const { month, year } = ctx.request.body;

      if (!month || !year) {
        return ctx.badRequest('month and year are required');
      }

      // Check if plan already exists for this month
      const existing = await strapi.entityService.findMany('api::blog-plan.blog-plan', {
        filters: { month, year },
        limit: 1,
      });

      if (existing && (existing as any[]).length > 0) {
        return ctx.badRequest(`Plan for ${month}/${year} already exists. Delete it first or use a different month.`);
      }

      // Generate topics using AI
      const topics = await strapi.service('api::blog-ai.blog-ai').analyzeAndGeneratePlan(month, year);

      // Create plan
      const plan = await strapi.entityService.create('api::blog-plan.blog-plan', {
        data: { month, year, stage: 'draft' },
      });

      // Calculate scheduled dates (one per week)
      const scheduledTopics = [];
      for (let i = 0; i < topics.length; i++) {
        const topic = topics[i];
        const weekNum = topic.weekNumber || (i + 1);
        const scheduledDate = getWeekDate(year, month, weekNum);

        const created = await strapi.entityService.create('api::blog-topic.blog-topic', {
          data: {
            title: topic.title,
            description: topic.description,
            keywords: topic.keywords || [],
            targetSlug: topic.targetSlug,
            scheduledDate,
            stage: 'proposed',
            internalLinks: topic.internalLinks || [],
            plan: plan.documentId,
          },
        });
        scheduledTopics.push(created);
      }

      ctx.body = {
        plan,
        topics: scheduledTopics,
      };
    } catch (err: any) {
      strapi.log.error('Blog AI generate-plan error:', err);
      return ctx.internalServerError(err.message || 'Failed to generate plan');
    }
  },

  // POST /api/blog-ai/generate-article/:topicId
  async generateArticle(ctx) {
    try {
      const { topicId } = ctx.params;

      if (!topicId) {
        return ctx.badRequest('topicId is required');
      }

      const result = await strapi.service('api::blog-ai.blog-ai').generateArticle(topicId);

      ctx.body = result;
    } catch (err: any) {
      strapi.log.error('Blog AI generate-article error:', err);
      return ctx.internalServerError(err.message || 'Failed to generate article');
    }
  },

  // PUT /api/blog-ai/topics/:topicId/approve
  async approveTopic(ctx) {
    try {
      const { topicId } = ctx.params;

      const topic: any = await findTopic(topicId);
      if (!topic) return ctx.notFound('Topic not found');
      if (topic.stage !== 'proposed') {
        return ctx.badRequest(`Cannot approve topic with stage "${topic.stage}"`);
      }

      const updated = await strapi.entityService.update('api::blog-topic.blog-topic', topic.id, {
        data: { stage: 'approved' },
      });

      ctx.body = updated;
    } catch (err: any) {
      strapi.log.error('Blog AI approve error:', err);
      return ctx.internalServerError(err.message || 'Failed to approve topic');
    }
  },

  // PUT /api/blog-ai/topics/:topicId/reject
  async rejectTopic(ctx) {
    try {
      const { topicId } = ctx.params;

      const topic: any = await findTopic(topicId);
      if (!topic) return ctx.notFound('Topic not found');
      if (topic.stage !== 'proposed') {
        return ctx.badRequest(`Cannot reject topic with stage "${topic.stage}"`);
      }

      const updated = await strapi.entityService.update('api::blog-topic.blog-topic', topic.id, {
        data: { stage: 'rejected' },
      });

      ctx.body = updated;
    } catch (err: any) {
      strapi.log.error('Blog AI reject error:', err);
      return ctx.internalServerError(err.message || 'Failed to reject topic');
    }
  },

  // DELETE /api/blog-ai/plans/:planId
  async deletePlan(ctx) {
    try {
      const { planId } = ctx.params;

      // Find plan by documentId
      const plans: any[] = await strapi.entityService.findMany('api::blog-plan.blog-plan', {
        filters: { documentId: planId },
        limit: 1,
      }) as any;
      const plan = plans?.[0];
      if (!plan) return ctx.notFound('Plan not found');

      // Delete all topics in this plan first
      const topics: any[] = await strapi.entityService.findMany('api::blog-topic.blog-topic', {
        filters: { plan: { documentId: planId } },
        limit: 50,
      }) as any;

      for (const topic of (topics || [])) {
        await strapi.entityService.delete('api::blog-topic.blog-topic', topic.id);
      }

      await strapi.entityService.delete('api::blog-plan.blog-plan', plan.id);

      ctx.body = { ok: true };
    } catch (err: any) {
      strapi.log.error('Blog AI delete plan error:', err);
      return ctx.internalServerError(err.message || 'Failed to delete plan');
    }
  },

  // PUT /api/blog-ai/topics/:topicId/update
  async updateTopic(ctx) {
    try {
      const { topicId } = ctx.params;
      const { title, description, keywords, targetSlug, scheduledDate } = ctx.request.body;

      const topic: any = await findTopic(topicId);
      if (!topic) return ctx.notFound('Topic not found');

      const data: any = {};
      if (title !== undefined) data.title = title;
      if (description !== undefined) data.description = description;
      if (keywords !== undefined) data.keywords = keywords;
      if (targetSlug !== undefined) data.targetSlug = targetSlug;
      if (scheduledDate !== undefined) data.scheduledDate = scheduledDate;

      const updated = await strapi.entityService.update('api::blog-topic.blog-topic', topic.id, {
        data,
      });

      ctx.body = updated;
    } catch (err: any) {
      strapi.log.error('Blog AI update topic error:', err);
      return ctx.internalServerError(err.message || 'Failed to update topic');
    }
  },
};

// Helper: get a date for week N of a given month
function getWeekDate(year: number, month: number, week: number): string {
  const day = Math.min((week - 1) * 7 + 3, 28); // mid-week, max 28
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
