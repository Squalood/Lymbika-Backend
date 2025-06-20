import type { Schema, Struct } from '@strapi/strapi';

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
      'video-id.youtube-video': VideoIdYoutubeVideo;
    }
  }
}
