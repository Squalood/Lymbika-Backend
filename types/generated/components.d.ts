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

export interface FeatureFeatures extends Struct.ComponentSchema {
  collectionName: 'components_feature_features';
  info: {
    description: '';
    displayName: 'features';
    icon: 'bulletList';
  };
  attributes: {
    title: Schema.Attribute.Text;
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
      'feature.features': FeatureFeatures;
      'video-id.youtube-video': VideoIdYoutubeVideo;
    }
  }
}
