import type { Schema, Struct } from '@strapi/strapi';

export interface ContentAskAnswer extends Struct.ComponentSchema {
  collectionName: 'components_content_ask_answers';
  info: {
    displayName: 'askAnswer';
    icon: 'bulletList';
  };
  attributes: {
    content: Schema.Attribute.Text;
    who: Schema.Attribute.Enumeration<['gpt', 'user']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'gpt'>;
  };
}

export interface ContentContentBaner extends Struct.ComponentSchema {
  collectionName: 'components_content_content_baners';
  info: {
    displayName: 'contentBaner';
    icon: 'cloud';
  };
  attributes: {
    cta: Schema.Attribute.Component<'content.link', false>;
    image: Schema.Attribute.Media<'images'>;
    title: Schema.Attribute.String;
  };
}

export interface ContentFaq extends Struct.ComponentSchema {
  collectionName: 'components_content_faqs';
  info: {
    displayName: 'faq';
    icon: 'chartCircle';
  };
  attributes: {
    item: Schema.Attribute.Component<'content.faq-item', true> &
      Schema.Attribute.Required;
  };
}

export interface ContentFaqItem extends Struct.ComponentSchema {
  collectionName: 'components_content_faq_items';
  info: {
    displayName: 'faqItem';
    icon: 'apps';
  };
  attributes: {
    content: Schema.Attribute.RichText &
      Schema.Attribute.Required &
      Schema.Attribute.CustomField<
        'plugin::ckeditor5.CKEditor',
        {
          preset: 'defaultHtml';
        }
      >;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
  };
}

export interface ContentGalery extends Struct.ComponentSchema {
  collectionName: 'components_content_galeries';
  info: {
    displayName: 'galery';
    icon: 'chartBubble';
  };
  attributes: {
    contentAfter: Schema.Attribute.RichText &
      Schema.Attribute.CustomField<
        'plugin::ckeditor5.CKEditor',
        {
          preset: 'defaultHtml';
        }
      >;
    contentBefore: Schema.Attribute.RichText &
      Schema.Attribute.CustomField<
        'plugin::ckeditor5.CKEditor',
        {
          preset: 'defaultHtml';
        }
      >;
    cta: Schema.Attribute.Component<'content.link', false>;
    image: Schema.Attribute.Media<'images', true> & Schema.Attribute.Required;
    title: Schema.Attribute.String;
  };
}

export interface ContentGaleryInstagram extends Struct.ComponentSchema {
  collectionName: 'components_content_galery_instagrams';
  info: {
    displayName: 'galeryInstagram';
    icon: 'chartCircle';
  };
  attributes: {
    media: Schema.Attribute.Media<'images' | 'videos'>;
    type: Schema.Attribute.Enumeration<['video', 'image']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'image'>;
  };
}

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

export interface ContentOficialData extends Struct.ComponentSchema {
  collectionName: 'components_content_oficial_data';
  info: {
    displayName: 'oficialData';
    icon: 'alien';
  };
  attributes: {
    addressInCz: Schema.Attribute.String & Schema.Attribute.Required;
    addressInHome: Schema.Attribute.String & Schema.Attribute.Required;
    dateBirth: Schema.Attribute.String & Schema.Attribute.Required;
    documentNumber: Schema.Attribute.String & Schema.Attribute.Required;
    documents: Schema.Attribute.Media<'images' | 'files', true>;
    email: Schema.Attribute.String & Schema.Attribute.Required;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    phone: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface ContentPriceList extends Struct.ComponentSchema {
  collectionName: 'components_content_price_lists';
  info: {
    displayName: 'priceList';
    icon: 'bulletList';
  };
  attributes: {
    contentAfter: Schema.Attribute.RichText &
      Schema.Attribute.CustomField<
        'plugin::ckeditor5.CKEditor',
        {
          preset: 'defaultHtml';
        }
      >;
    contentBefore: Schema.Attribute.RichText &
      Schema.Attribute.CustomField<
        'plugin::ckeditor5.CKEditor',
        {
          preset: 'defaultHtml';
        }
      >;
    cta: Schema.Attribute.Component<'content.link', false>;
    pricelistTable: Schema.Attribute.Relation<
      'oneToOne',
      'api::pricelist.pricelist'
    >;
    title: Schema.Attribute.String;
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
    description: '';
    displayName: 'tableItem';
    icon: 'database';
  };
  attributes: {
    juniorPrice: Schema.Attribute.String & Schema.Attribute.Required;
    linkRezervation: Schema.Attribute.String;
    masterPrice: Schema.Attribute.String;
    title: Schema.Attribute.String & Schema.Attribute.Required;
    topMasterPrice: Schema.Attribute.String;
  };
}

export interface ContentText extends Struct.ComponentSchema {
  collectionName: 'components_content_texts';
  info: {
    description: '';
    displayName: 'text';
    icon: 'apps';
  };
  attributes: {
    contentText: Schema.Attribute.RichText &
      Schema.Attribute.Required &
      Schema.Attribute.CustomField<
        'plugin::ckeditor5.CKEditor',
        {
          preset: 'defaultHtml';
        }
      >;
    cta: Schema.Attribute.Component<'content.link', false>;
    title: Schema.Attribute.String;
  };
}

export interface ContentWeek extends Struct.ComponentSchema {
  collectionName: 'components_content_weeks';
  info: {
    displayName: 'week';
    icon: 'database';
  };
  attributes: {
    friday: Schema.Attribute.String & Schema.Attribute.Required;
    monday: Schema.Attribute.String & Schema.Attribute.Required;
    saturday: Schema.Attribute.String & Schema.Attribute.Required;
    sunday: Schema.Attribute.String & Schema.Attribute.Required;
    thursday: Schema.Attribute.String & Schema.Attribute.Required;
    tuesday: Schema.Attribute.String & Schema.Attribute.Required;
    wednesday: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface ItemsMoneyFlow extends Struct.ComponentSchema {
  collectionName: 'components_items_money_flows';
  info: {
    displayName: 'moneyFlow';
    icon: 'bulletList';
  };
  attributes: {
    coment: Schema.Attribute.Text;
    sum: Schema.Attribute.BigInteger & Schema.Attribute.Required;
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

export interface ItemsRates extends Struct.ComponentSchema {
  collectionName: 'components_items_rates';
  info: {
    displayName: 'rates';
    icon: 'chartCircle';
  };
  attributes: {
    from: Schema.Attribute.Date & Schema.Attribute.Required;
    rate: Schema.Attribute.BigInteger & Schema.Attribute.Required;
    to: Schema.Attribute.Date;
    typeWork: Schema.Attribute.Enumeration<['hpp', 'dpp']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'dpp'>;
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
      'content.ask-answer': ContentAskAnswer;
      'content.content-baner': ContentContentBaner;
      'content.faq': ContentFaq;
      'content.faq-item': ContentFaqItem;
      'content.galery': ContentGalery;
      'content.galery-instagram': ContentGaleryInstagram;
      'content.link': ContentLink;
      'content.oficial-data': ContentOficialData;
      'content.price-list': ContentPriceList;
      'content.table': ContentTable;
      'content.table-item': ContentTableItem;
      'content.text': ContentText;
      'content.week': ContentWeek;
      'items.money-flow': ItemsMoneyFlow;
      'items.nav-item': ItemsNavItem;
      'items.rates': ItemsRates;
      'items.soc-item': ItemsSocItem;
      'seo.meta': SeoMeta;
    }
  }
}
