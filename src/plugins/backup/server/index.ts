import controller from './controllers/backup';
import service from './services/backup';
import routes from './routes/index';

export default {
  register({ strapi }: { strapi: any }) {},
  bootstrap({ strapi }: { strapi: any }) {},
  destroy({ strapi }: { strapi: any }) {},
  routes,
  controllers: {
    backup: controller,
  },
  services: {
    backup: service,
  },
};
