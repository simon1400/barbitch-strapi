import type { Schema, Struct } from '@strapi/strapi';

export interface BookingServiceModifier extends Struct.ComponentSchema {
  collectionName: 'components_booking_service_modifiers';
  info: {
    displayName: 'serviceModifier';
    icon: 'check';
  };
  attributes: {
    description: Schema.Attribute.Text;
    durationDiff: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    group: Schema.Attribute.String;
    key: Schema.Attribute.String & Schema.Attribute.Required;
    label: Schema.Attribute.String & Schema.Attribute.Required;
    priceDiff: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<0>;
  };
}

export interface BookingServiceRestriction extends Struct.ComponentSchema {
  collectionName: 'components_booking_service_restrictions';
  info: {
    description: '\u041E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0435 \u043C\u0430\u0441\u0442\u0435\u0440\u0430 \u043F\u043E \u0443\u0441\u043B\u0443\u0433\u0435: \u043A\u0430\u043A\u0438\u0435 \u0432\u0430\u0440\u0438\u0430\u043D\u0442\u044B/\u0434\u043E\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F \u043E\u043D \u0434\u0435\u043B\u0430\u0435\u0442. \u041F\u0443\u0441\u0442\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435 (null) = \u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u043E \u0432\u0441\u0451, \u043F\u0443\u0441\u0442\u043E\u0439 \u043C\u0430\u0441\u0441\u0438\u0432 = \u043D\u0435 \u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u043E \u043D\u0438\u0447\u0435\u0433\u043E (\u0442\u043E\u043B\u044C\u043A\u043E \u0431\u0430\u0437\u0430).';
    displayName: 'serviceRestriction';
    icon: 'lock';
  };
  attributes: {
    allowedModifiers: Schema.Attribute.JSON;
    allowedVariants: Schema.Attribute.JSON;
    personalDocId: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface BookingServiceVariant extends Struct.ComponentSchema {
  collectionName: 'components_booking_service_variants';
  info: {
    displayName: 'serviceVariant';
    icon: 'layer';
  };
  attributes: {
    description: Schema.Attribute.Text;
    durationDiff: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    label: Schema.Attribute.String & Schema.Attribute.Required;
    priceDiff: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<0>;
  };
}

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

export interface ContentGaleryItem extends Struct.ComponentSchema {
  collectionName: 'components_content_galery_items';
  info: {
    description: 'Jedna fotka galerie \u201ENa\u0161e pr\u00E1ce\u201C na hlavn\u00ED str\u00E1nce: slu\u017Eba (\u010Dip filtru a \u0161t\u00EDtek), sekce rezervace (tla\u010D\u00EDtko \u201ERezervovat\u201C otev\u0159e /book s rozbalenou sekc\u00ED) a popisek v prohl\u00ED\u017Ee\u010Di.';
    displayName: 'Galerie \u2014 fotka';
    icon: 'picture';
  };
  attributes: {
    active: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    bookingSection: Schema.Attribute.Enumeration<
      ['Nehty', 'Oboci', 'Rasy_barveni_a_pece', 'Prodluzovani_ras']
    >;
    caption: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 60;
      }>;
    description: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 400;
      }>;
    image: Schema.Attribute.Media<'images'> & Schema.Attribute.Required;
    service: Schema.Attribute.Relation<'oneToOne', 'api::service.service'>;
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
    addressInCz: Schema.Attribute.String;
    addressInHome: Schema.Attribute.String;
    bankAccount: Schema.Attribute.String;
    dateBirth: Schema.Attribute.String;
    documentNumber: Schema.Attribute.String;
    email: Schema.Attribute.String;
    emergencyName: Schema.Attribute.String;
    emergencyPhone: Schema.Attribute.String;
    name: Schema.Attribute.String;
    phone: Schema.Attribute.String;
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
    pricelistFilter: Schema.Attribute.String;
    title: Schema.Attribute.String;
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

export interface ContentWhyItem extends Struct.ComponentSchema {
  collectionName: 'components_content_why_items';
  info: {
    description: 'Jedna r\u016F\u017Eov\u00E1 p\u00E1ska v sekci \u201EPro\u010D Barbitch\u201C na hlavn\u00ED str\u00E1nce: nadpis, kr\u00E1tk\u00FD text a voliteln\u00FD odkaz (text odkazu + adresa, nap\u0159. /bitchcard).';
    displayName: 'Pro\u010D Barbitch \u2014 p\u00E1ska';
    icon: 'heart';
  };
  attributes: {
    linkLabel: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 30;
      }>;
    linkUrl: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 200;
      }>;
    text: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 40;
      }>;
  };
}

export interface ItemsContracts extends Struct.ComponentSchema {
  collectionName: 'components_items_contracts';
  info: {
    description: '\u0414\u043E\u0433\u043E\u0432\u043E\u0440 \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0430 (s231): \u0442\u043E\u043B\u044C\u043A\u043E \u0443\u0447\u0451\u0442 \u2014 \u043D\u0430 \u0437\u0430\u0440\u043F\u043B\u0430\u0442\u044B \u0438 \u043D\u0430\u043B\u043E\u0433\u0438 \u043D\u0435 \u0432\u043B\u0438\u044F\u0435\u0442 (\u0441\u043C\u044B\u0441\u043B \u043E\u043F\u043B\u0430\u0442\u044B \u043D\u0435\u0441\u0451\u0442 rates.typeWork)';
    displayName: 'contracts';
    icon: 'file';
  };
  attributes: {
    from: Schema.Attribute.Date & Schema.Attribute.Required;
    ico: Schema.Attribute.String;
    note: Schema.Attribute.String;
    probationUntil: Schema.Attribute.Date;
    to: Schema.Attribute.Date;
    type: Schema.Attribute.Enumeration<['hpp', 'dpp', 'ico']> &
      Schema.Attribute.Required;
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
    hourlyRate: Schema.Attribute.Integer;
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
      'booking.service-modifier': BookingServiceModifier;
      'booking.service-restriction': BookingServiceRestriction;
      'booking.service-variant': BookingServiceVariant;
      'content.ask-answer': ContentAskAnswer;
      'content.content-baner': ContentContentBaner;
      'content.faq': ContentFaq;
      'content.faq-item': ContentFaqItem;
      'content.galery': ContentGalery;
      'content.galery-instagram': ContentGaleryInstagram;
      'content.galery-item': ContentGaleryItem;
      'content.link': ContentLink;
      'content.oficial-data': ContentOficialData;
      'content.price-list': ContentPriceList;
      'content.text': ContentText;
      'content.week': ContentWeek;
      'content.why-item': ContentWhyItem;
      'items.contracts': ItemsContracts;
      'items.money-flow': ItemsMoneyFlow;
      'items.nav-item': ItemsNavItem;
      'items.rates': ItemsRates;
      'items.soc-item': ItemsSocItem;
      'seo.meta': SeoMeta;
    }
  }
}
