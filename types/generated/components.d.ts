import type { Schema, Struct } from '@strapi/strapi';

export interface ButtonButton extends Struct.ComponentSchema {
  collectionName: 'components_button_buttons';
  info: {
    description: '';
    displayName: 'button';
    icon: 'book';
  };
  attributes: {
    icon: Schema.Attribute.Enumeration<['MoveRight', 'PhoneCall']>;
    label: Schema.Attribute.String;
    link: Schema.Attribute.String;
    linkF: Schema.Attribute.String;
    linkP: Schema.Attribute.String;
    variant: Schema.Attribute.Enumeration<['default', 'outline']>;
  };
}

export interface ContactContact extends Struct.ComponentSchema {
  collectionName: 'components_contact_contacts';
  info: {
    description: '';
    displayName: 'Contact';
    icon: 'phone';
  };
  attributes: {
    contactLocation: Schema.Attribute.Text;
    contactPhone: Schema.Attribute.String;
    contactScheduleLink: Schema.Attribute.String;
    contactWhatsappLink: Schema.Attribute.String;
    description: Schema.Attribute.Text;
    direccionText: Schema.Attribute.Text;
    image: Schema.Attribute.Media<'images' | 'files' | 'videos' | 'audios'>;
    timeText: Schema.Attribute.String;
    title: Schema.Attribute.String;
  };
}

export interface DoctorDoctor extends Struct.ComponentSchema {
  collectionName: 'components_doctor_doctors';
  info: {
    description: '';
    displayName: 'doctor';
    icon: 'briefcase';
  };
  attributes: {
    description: Schema.Attribute.Text;
    image: Schema.Attribute.Media<'images' | 'files' | 'videos' | 'audios'>;
    mapsEmbedUrl: Schema.Attribute.Text;
    name: Schema.Attribute.String;
    points: Schema.Attribute.Blocks;
  };
}

export interface FeatureFeatures extends Struct.ComponentSchema {
  collectionName: 'components_feature_features';
  info: {
    description: '';
    displayName: 'features';
    icon: 'bulletList';
  };
  attributes: {
    description: Schema.Attribute.Text;
    icon: Schema.Attribute.Enumeration<
      [
        'icon1',
        'icon2',
        'icon3',
        'icon4',
        'icon5',
        'icon6',
        'Stethoscope',
        'Activity',
        'Heart',
        'HeartPulse,',
        'Brain',
        'ScanHeart',
        'Hospital',
        'Ribbon',
        'Venus',
        'Baby',
        'Sparkles',
        'Shell',
        'ClipboardPlus',
        'Syringe',
        'Dumbbell',
        'BriefcaseMedical',
        'Ambulance',
        'Bandage',
        'Pill',
        'Percent',
        'CalendarPlus',
        'UserRoundPlus',
        'Waypoints',
        'Presentation',
        'ChartNoAxesCombined',
        'Handshake',
        'Globe',
      ]
    >;
    title: Schema.Attribute.Text;
  };
}

export interface GalleryGallery extends Struct.ComponentSchema {
  collectionName: 'components_gallery_galleries';
  info: {
    displayName: 'gallery';
    icon: 'landscape';
  };
  attributes: {
    images: Schema.Attribute.Media<
      'images' | 'files' | 'videos' | 'audios',
      true
    >;
    title: Schema.Attribute.String;
  };
}

export interface HeroHero extends Struct.ComponentSchema {
  collectionName: 'components_hero_heroes';
  info: {
    displayName: 'hero';
    icon: 'picture';
  };
  attributes: {
    buttonText: Schema.Attribute.String;
    buttonUrl: Schema.Attribute.String;
    description: Schema.Attribute.Text;
    image: Schema.Attribute.Media<'images' | 'files' | 'videos' | 'audios'>;
    title: Schema.Attribute.String;
  };
}

export interface ItemFaqItem extends Struct.ComponentSchema {
  collectionName: 'components_item_faq_items';
  info: {
    displayName: 'faq-item';
    icon: 'bulletList';
  };
  attributes: {
    answer: Schema.Attribute.Text;
    question: Schema.Attribute.Text;
  };
}

export interface LessLess extends Struct.ComponentSchema {
  collectionName: 'components_less_lesses';
  info: {
    description: '';
    displayName: 'less';
    icon: 'arrowDown';
  };
  attributes: {
    text: Schema.Attribute.Text;
  };
}

export interface PlusPlus extends Struct.ComponentSchema {
  collectionName: 'components_plus_pluses';
  info: {
    description: '';
    displayName: 'plus';
    icon: 'check';
  };
  attributes: {
    text: Schema.Attribute.Text;
  };
}

export interface PricingPlan extends Struct.ComponentSchema {
  collectionName: 'components_pricing_plans';
  info: {
    displayName: 'plan';
    icon: 'store';
  };
  attributes: {
    description: Schema.Attribute.Text;
    less: Schema.Attribute.Component<'less.less', true>;
    link: Schema.Attribute.String;
    name: Schema.Attribute.String;
    plus: Schema.Attribute.Component<'plus.plus', true>;
    price: Schema.Attribute.Decimal;
    prominent: Schema.Attribute.Boolean;
  };
}

export interface PromoPromo extends Struct.ComponentSchema {
  collectionName: 'components_promo_promos';
  info: {
    description: '';
    displayName: 'promo';
    icon: 'crown';
  };
  attributes: {
    image: Schema.Attribute.Media<'images' | 'files' | 'videos' | 'audios'>;
    link: Schema.Attribute.String;
    title: Schema.Attribute.String;
  };
}

export interface ServiceServices extends Struct.ComponentSchema {
  collectionName: 'components_service_services';
  info: {
    description: '';
    displayName: 'services';
    icon: 'bulletList';
  };
  attributes: {
    description: Schema.Attribute.String;
    icon: Schema.Attribute.Enumeration<
      [
        'icon1',
        'icon2',
        'icon3',
        'icon4',
        'icon5',
        'icon6',
        'Stethoscope',
        'Activity',
        'Heart',
        'HeartPulse,',
        'Brain',
        'ScanHeart',
        'Hospital',
        'Ribbon',
        'Venus',
        'Baby',
        'Sparkles',
        'Shell',
        'ClipboardPlus',
        'Syringe',
        'Dumbbell',
        'BriefcaseMedical',
        'Ambulance',
        'Bandage',
        'Pill',
        'CalendarPlus',
        'UserRoundPlus',
        'Waypoints',
        'Presentation',
        'ChartNoAxesCombined',
        'Handshake',
        'Globe',
      ]
    >;
    image: Schema.Attribute.Media<'images' | 'files' | 'videos' | 'audios'>;
    price: Schema.Attribute.Decimal;
    title: Schema.Attribute.String;
  };
}

export interface TestimonialTestimonials extends Struct.ComponentSchema {
  collectionName: 'components_testimonial_testimonials';
  info: {
    displayName: 'testimonials';
    icon: 'emotionHappy';
  };
  attributes: {
    name: Schema.Attribute.String;
    rating: Schema.Attribute.Decimal;
    text: Schema.Attribute.Text;
  };
}

export interface VideoIdYoutubeVideo extends Struct.ComponentSchema {
  collectionName: 'components_video_id_youtube_videos';
  info: {
    description: '';
    displayName: 'youtube-video';
    icon: 'play';
  };
  attributes: {
    title: Schema.Attribute.String;
    videoID: Schema.Attribute.String;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'button.button': ButtonButton;
      'contact.contact': ContactContact;
      'doctor.doctor': DoctorDoctor;
      'feature.features': FeatureFeatures;
      'gallery.gallery': GalleryGallery;
      'hero.hero': HeroHero;
      'item.faq-item': ItemFaqItem;
      'less.less': LessLess;
      'plus.plus': PlusPlus;
      'pricing.plan': PricingPlan;
      'promo.promo': PromoPromo;
      'service.services': ServiceServices;
      'testimonial.testimonials': TestimonialTestimonials;
      'video-id.youtube-video': VideoIdYoutubeVideo;
    }
  }
}
