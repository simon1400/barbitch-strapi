export default {
  routes: [
    {
      method: 'POST',
      path: '/blog-ai/generate-plan',
      handler: 'blog-ai.generatePlan',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/blog-ai/generate-article/:topicId',
      handler: 'blog-ai.generateArticle',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'PUT',
      path: '/blog-ai/topics/:topicId/approve',
      handler: 'blog-ai.approveTopic',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'PUT',
      path: '/blog-ai/topics/:topicId/reject',
      handler: 'blog-ai.rejectTopic',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'PUT',
      path: '/blog-ai/topics/:topicId/update',
      handler: 'blog-ai.updateTopic',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'DELETE',
      path: '/blog-ai/plans/:planId',
      handler: 'blog-ai.deletePlan',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
