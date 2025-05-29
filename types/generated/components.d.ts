import type { Schema, Struct } from '@strapi/strapi';

export interface MondayDay extends Struct.ComponentSchema {
  collectionName: 'components_monday_days';
  info: {
    displayName: 'day';
    icon: '';
  };
  attributes: {};
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'monday.day': MondayDay;
    }
  }
}
