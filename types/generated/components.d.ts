import type { Schema, Struct } from '@strapi/strapi';

export interface ContentLink extends Struct.ComponentSchema {
  collectionName: 'components_content_links';
  info: {
    displayName: 'link';
    icon: 'cursor';
  };
  attributes: {
    link: Schema.Attribute.String & Schema.Attribute.Required;
    title: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface ContentTable extends Struct.ComponentSchema {
  collectionName: 'components_content_tables';
  info: {
    description: '';
    displayName: 'table';
    icon: 'bulletList';
  };
  attributes: {
    item: Schema.Attribute.Component<'content.table-item', true> &
      Schema.Attribute.Required;
    title: Schema.Attribute.String;
  };
}

export interface ContentTableItem extends Struct.ComponentSchema {
  collectionName: 'components_content_table_items';
  info: {
    displayName: 'tableItem';
    icon: 'database';
  };
  attributes: {
    juniorPrice: Schema.Attribute.String & Schema.Attribute.Required;
    masterPrice: Schema.Attribute.String;
    title: Schema.Attribute.String & Schema.Attribute.Required;
    topMasterPrice: Schema.Attribute.String;
  };
}

export interface ItemsNavItem extends Struct.ComponentSchema {
  collectionName: 'components_items_nav_items';
  info: {
    displayName: 'NavItem';
    icon: 'apps';
  };
  attributes: {
    link: Schema.Attribute.String & Schema.Attribute.Required;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
  };
}

export interface ItemsSocItem extends Struct.ComponentSchema {
  collectionName: 'components_items_soc_items';
  info: {
    displayName: 'SocItem';
    icon: 'bulletList';
  };
  attributes: {
    link: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    type: Schema.Attribute.Enumeration<['tiktok', 'instagram', 'facebook']>;
  };
}

export interface SeoMeta extends Struct.ComponentSchema {
  collectionName: 'components_seo_metas';
  info: {
    description: '';
    displayName: 'meta';
    icon: 'alien';
  };
  attributes: {
    description: Schema.Attribute.Text;
    image: Schema.Attribute.Media<'images' | 'files'>;
    title: Schema.Attribute.String;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'content.link': ContentLink;
      'content.table': ContentTable;
      'content.table-item': ContentTableItem;
      'items.nav-item': ItemsNavItem;
      'items.soc-item': ItemsSocItem;
      'seo.meta': SeoMeta;
    }
  }
}
