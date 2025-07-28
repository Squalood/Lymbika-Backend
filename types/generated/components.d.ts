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
      ['icon1', 'icon2', 'icon3', 'icon4', 'icon5', 'icon6']
    >;
    title: Schema.Attribute.Text;
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

export interface ServiceServices extends Struct.ComponentSchema {
  collectionName: 'components_service_services';
  info: {
    displayName: 'services';
    icon: 'bulletList';
  };
  attributes: {
    description: Schema.Attribute.String;
    icon: Schema.Attribute.Enumeration<
      ['icon1', 'icon2', 'icon3', 'icon4', 'icon5', 'icon6']
    >;
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
    videoID: Schema.Attribute.String;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'button.button': ButtonButton;
      'doctor.doctor': DoctorDoctor;
      'feature.features': FeatureFeatures;
      'item.faq-item': ItemFaqItem;
      'service.services': ServiceServices;
      'testimonial.testimonials': TestimonialTestimonials;
      'video-id.youtube-video': VideoIdYoutubeVideo;
    }
  }
}
