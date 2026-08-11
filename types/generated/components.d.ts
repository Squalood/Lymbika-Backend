import type { Schema, Struct } from '@strapi/strapi';

export interface BadgeBadge extends Struct.ComponentSchema {
  collectionName: 'components_badge_badges';
  info: {
    displayName: 'badge';
    icon: 'priceTag';
  };
  attributes: {
    boldText: Schema.Attribute.String;
    tag: Schema.Attribute.String;
    text: Schema.Attribute.String;
  };
}

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

export interface CompraItemCompraItem extends Struct.ComponentSchema {
  collectionName: 'components_compra_item_compra_items';
  info: {
    displayName: 'compra-item';
    icon: 'arrowDown';
  };
  attributes: {
    costoUnitario: Schema.Attribute.Decimal;
    fechaCaducidad: Schema.Attribute.Date;
    iva: Schema.Attribute.Enumeration<['iva8', 'iva16', 'exento']> &
      Schema.Attribute.DefaultTo<'exento'>;
    numeroLote: Schema.Attribute.String;
    product: Schema.Attribute.Relation<'oneToOne', 'api::product.product'>;
    productName: Schema.Attribute.String;
    quantity: Schema.Attribute.Integer;
    totalLine: Schema.Attribute.Decimal;
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

export interface FacturaItemItems extends Struct.ComponentSchema {
  collectionName: 'components_factura_item_items';
  info: {
    displayName: 'items';
    icon: 'envelop';
  };
  attributes: {
    cantidad: Schema.Attribute.Decimal;
    descripcion: Schema.Attribute.Text & Schema.Attribute.Required;
    impuesto: Schema.Attribute.Enumeration<['iva16', 'iva8', 'exento']> &
      Schema.Attribute.Required;
    precioUnitario: Schema.Attribute.Decimal;
    product: Schema.Attribute.Relation<'oneToOne', 'api::product.product'>;
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
        'HeartHandshake',
        'Home',
        'Leaf',
        'ShieldCheck',
        'UserCheck',
        'PillBottle',
        'ClipboardCheck',
      ]
    >;
    title: Schema.Attribute.String;
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

export interface HeroHeroAlt extends Struct.ComponentSchema {
  collectionName: 'components_hero_hero_alts';
  info: {
    displayName: 'heroAlt';
    icon: 'alien';
  };
  attributes: {
    eyebrow: Schema.Attribute.String;
    hero_image: Schema.Attribute.Media<
      'images' | 'files' | 'videos' | 'audios'
    >;
    hero_video: Schema.Attribute.Media<
      'images' | 'files' | 'videos' | 'audios'
    >;
    price_display: Schema.Attribute.Text;
    subtitle: Schema.Attribute.Text;
    trust_pills: Schema.Attribute.Component<'item.pill', true>;
  };
}

export interface HomeAlyusFeature extends Struct.ComponentSchema {
  collectionName: 'components_home_alyus_features';
  info: {
    displayName: 'alyus-feature';
    icon: 'bulletList';
  };
  attributes: {
    description: Schema.Attribute.Text;
    icon: Schema.Attribute.Enumeration<
      [
        'Zap',
        'Shield',
        'Brain',
        'Heart',
        'Clock',
        'Star',
        'Globe',
        'Phone',
        'Lock',
        'Activity',
        'Stethoscope',
        'Users',
        'Bot',
        'Sparkles',
        'Check',
        'Cpu',
        'Smile',
        'Medal',
        'Leaf',
        'FlaskConical',
        'MonitorSmartphone',
        'MessageSquare',
        'Calendar',
        'CreditCard',
        'Video',
      ]
    >;
    title: Schema.Attribute.String;
  };
}

export interface HomeAlyusSection extends Struct.ComponentSchema {
  collectionName: 'components_home_alyus_sections';
  info: {
    displayName: 'alyus-section';
    icon: 'command';
  };
  attributes: {
    badge: Schema.Attribute.String;
    chatFooter: Schema.Attribute.String;
    ctaHref: Schema.Attribute.String;
    ctaText: Schema.Attribute.String;
    description: Schema.Attribute.Text;
    features: Schema.Attribute.Component<'home.alyus-feature', true>;
    label: Schema.Attribute.String;
    messages: Schema.Attribute.Component<'home.chat-message', true>;
    title: Schema.Attribute.String;
  };
}

export interface HomeAreDoctorsSection extends Struct.ComponentSchema {
  collectionName: 'components_home_are_doctors_sections';
  info: {
    displayName: 'are-doctors-section';
    icon: 'doctor';
  };
  attributes: {
    badge: Schema.Attribute.String;
    ctaHref: Schema.Attribute.String;
    ctaText: Schema.Attribute.String;
    description: Schema.Attribute.Text;
    perks: Schema.Attribute.Component<'item.pill', true>;
    testimonial: Schema.Attribute.Component<'testimonial.testimonials', false>;
    title: Schema.Attribute.String;
  };
}

export interface HomeBannerItem extends Struct.ComponentSchema {
  collectionName: 'components_home_banner_items';
  info: {
    displayName: 'banner-item';
    icon: 'hashtag';
  };
  attributes: {
    icon: Schema.Attribute.Enumeration<
      [
        'BadgeCheck',
        'ShoppingBag',
        'Clock',
        'GraduationCap',
        'Shield',
        'CreditCard',
        'Stethoscope',
        'Hospital',
        'MessageCircleHeart',
        'BookUser',
        'ShieldCheck',
        'Plane',
      ]
    >;
    text: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface HomeCarouselServices extends Struct.ComponentSchema {
  collectionName: 'components_home_carousel_services';
  info: {
    displayName: 'carousel-services';
    icon: 'stack';
  };
  attributes: {
    allLabel: Schema.Attribute.String;
    ctaLabel: Schema.Attribute.String;
    description: Schema.Attribute.Text;
    emptyLabel: Schema.Attribute.String;
    hideDetailsLabel: Schema.Attribute.String;
    priceLabel: Schema.Attribute.String;
    showDetailsLabel: Schema.Attribute.String;
    subTitle: Schema.Attribute.String;
    title: Schema.Attribute.String;
  };
}

export interface HomeChatMessage extends Struct.ComponentSchema {
  collectionName: 'components_home_chat_messages';
  info: {
    displayName: 'chat-message';
    icon: 'discuss';
  };
  attributes: {
    from: Schema.Attribute.Enumeration<['ai', 'user']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'ai'>;
    text: Schema.Attribute.Text & Schema.Attribute.Required;
  };
}

export interface HomeChooseCategory extends Struct.ComponentSchema {
  collectionName: 'components_home_choose_categories';
  info: {
    displayName: 'choose-category';
    icon: 'apps';
  };
  attributes: {
    title: Schema.Attribute.String;
  };
}

export interface HomeClinics extends Struct.ComponentSchema {
  collectionName: 'components_home_clinics';
  info: {
    displayName: 'clinics';
    icon: 'manyToMany';
  };
  attributes: {
    title: Schema.Attribute.String;
  };
}

export interface HomeHospitalSection extends Struct.ComponentSchema {
  collectionName: 'components_home_hospital_sections';
  info: {
    displayName: 'hospital-section';
    icon: 'house';
  };
  attributes: {
    title: Schema.Attribute.String;
  };
}

export interface HomePromoCarousel extends Struct.ComponentSchema {
  collectionName: 'components_home_promo_carousels';
  info: {
    displayName: 'promo-carousel';
    icon: 'crown';
  };
  attributes: {
    aspectRatio: Schema.Attribute.Enumeration<['square', 'video', 'portrait']> &
      Schema.Attribute.DefaultTo<'video'>;
    promos: Schema.Attribute.Component<'promo.promo', true>;
  };
}

export interface HomeSurgeryFaq extends Struct.ComponentSchema {
  collectionName: 'components_home_surgery_faqs';
  info: {
    displayName: 'surgery-faq';
    icon: 'quote';
  };
  attributes: {
    faq_group: Schema.Attribute.Relation<
      'oneToOne',
      'api::faq-group.faq-group'
    >;
    title: Schema.Attribute.String;
  };
}

export interface HomeTextBanner extends Struct.ComponentSchema {
  collectionName: 'components_home_text_banners';
  info: {
    displayName: 'text-banner';
    icon: 'layer';
  };
  attributes: {
    item: Schema.Attribute.Component<'home.banner-item', true>;
  };
}

export interface HomeTuristSection extends Struct.ComponentSchema {
  collectionName: 'components_home_turist_sections';
  info: {
    displayName: 'turist-section';
    icon: 'envelop';
  };
  attributes: {
    ctaHref: Schema.Attribute.String;
    ctaText: Schema.Attribute.String;
    description: Schema.Attribute.Text;
    label: Schema.Attribute.String;
    testimonial: Schema.Attribute.Component<'testimonial.testimonials', false>;
    title: Schema.Attribute.String;
    videoId: Schema.Attribute.String;
    videoLabel: Schema.Attribute.String;
  };
}

export interface HomeVideosSection extends Struct.ComponentSchema {
  collectionName: 'components_home_videos_sections';
  info: {
    displayName: 'videos-section';
    icon: 'play';
  };
  attributes: {
    title: Schema.Attribute.String;
    videos: Schema.Attribute.Component<'video-id.youtube-video', true>;
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

export interface ItemPill extends Struct.ComponentSchema {
  collectionName: 'components_item_pills';
  info: {
    displayName: 'pill';
    icon: 'quote';
  };
  attributes: {
    text: Schema.Attribute.String;
  };
}

export interface ItemValues extends Struct.ComponentSchema {
  collectionName: 'components_item_values';
  info: {
    displayName: 'values';
    icon: 'apps';
  };
  attributes: {
    label: Schema.Attribute.String;
    number: Schema.Attribute.String;
  };
}

export interface LandingTextsLandingTextsMedicalService
  extends Struct.ComponentSchema {
  collectionName: 'components_landing_texts_landing_texts_medical_services';
  info: {
    displayName: 'landing.texts.Medical-Service';
    icon: 'bulletList';
  };
  attributes: {
    benefits_label: Schema.Attribute.String;
    benefits_title: Schema.Attribute.String;
    cta_button: Schema.Attribute.String;
    cta_subtitle: Schema.Attribute.Text;
    cta_title: Schema.Attribute.String;
    doctors_label: Schema.Attribute.String;
    doctors_label_plural: Schema.Attribute.String;
    doctors_profile_button: Schema.Attribute.String;
    doctors_title: Schema.Attribute.String;
    doctors_title_plural: Schema.Attribute.String;
    faq_header_subtitle: Schema.Attribute.String;
    faq_header_title: Schema.Attribute.String;
    faq_label: Schema.Attribute.String;
    gallery_label: Schema.Attribute.String;
    gallery_title: Schema.Attribute.String;
    hero_price_label: Schema.Attribute.String;
    hero_primary_button: Schema.Attribute.String;
    hero_secondary_button: Schema.Attribute.String;
    package_cta_button: Schema.Attribute.String;
    package_label_section: Schema.Attribute.String;
    package_title: Schema.Attribute.String;
    video_label: Schema.Attribute.String;
  };
}

export interface ModalSteps extends Struct.ComponentSchema {
  collectionName: 'components_modal_steps';
  info: {
    displayName: 'steps';
    icon: 'plus';
  };
  attributes: {
    description: Schema.Attribute.Text;
    icon: Schema.Attribute.Enumeration<['Mail', 'Phone', 'Rocket']>;
    title: Schema.Attribute.String;
  };
}

export interface ModalTrustModal extends Struct.ComponentSchema {
  collectionName: 'components_modal_trust_modals';
  info: {
    displayName: 'TrustModal';
    icon: 'handHeart';
  };
  attributes: {
    ctaLabel: Schema.Attribute.String;
    subtitle: Schema.Attribute.String;
    title: Schema.Attribute.String;
    TrustStep: Schema.Attribute.Component<'modal.steps', true>;
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

export interface TestimonialTestimonials extends Struct.ComponentSchema {
  collectionName: 'components_testimonial_testimonials';
  info: {
    displayName: 'testimonials';
    icon: 'emotionHappy';
  };
  attributes: {
    name: Schema.Attribute.String;
    rating: Schema.Attribute.Decimal;
    role: Schema.Attribute.String;
    text: Schema.Attribute.Text;
  };
}

export interface VentaItemVentaItem extends Struct.ComponentSchema {
  collectionName: 'components_venta_item_venta_items';
  info: {
    displayName: 'venta-item';
    icon: 'shoppingCart';
  };
  attributes: {
    expirationDate: Schema.Attribute.Date;
    lotDocumentId: Schema.Attribute.String;
    lotNumber: Schema.Attribute.String;
    product: Schema.Attribute.Relation<'oneToOne', 'api::product.product'>;
    productName: Schema.Attribute.String;
    quantity: Schema.Attribute.Integer;
    service_rate: Schema.Attribute.Relation<
      'oneToOne',
      'api::service-rate.service-rate'
    >;
    totalLine: Schema.Attribute.Decimal;
    type: Schema.Attribute.Enumeration<['product', 'service']>;
    unitPrice: Schema.Attribute.Decimal;
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
      'badge.badge': BadgeBadge;
      'button.button': ButtonButton;
      'compra-item.compra-item': CompraItemCompraItem;
      'contact.contact': ContactContact;
      'doctor.doctor': DoctorDoctor;
      'factura-item.items': FacturaItemItems;
      'feature.features': FeatureFeatures;
      'gallery.gallery': GalleryGallery;
      'hero.hero': HeroHero;
      'hero.hero-alt': HeroHeroAlt;
      'home.alyus-feature': HomeAlyusFeature;
      'home.alyus-section': HomeAlyusSection;
      'home.are-doctors-section': HomeAreDoctorsSection;
      'home.banner-item': HomeBannerItem;
      'home.carousel-services': HomeCarouselServices;
      'home.chat-message': HomeChatMessage;
      'home.choose-category': HomeChooseCategory;
      'home.clinics': HomeClinics;
      'home.hospital-section': HomeHospitalSection;
      'home.promo-carousel': HomePromoCarousel;
      'home.surgery-faq': HomeSurgeryFaq;
      'home.text-banner': HomeTextBanner;
      'home.turist-section': HomeTuristSection;
      'home.videos-section': HomeVideosSection;
      'item.faq-item': ItemFaqItem;
      'item.pill': ItemPill;
      'item.values': ItemValues;
      'landing-texts.landing-texts-medical-service': LandingTextsLandingTextsMedicalService;
      'modal.steps': ModalSteps;
      'modal.trust-modal': ModalTrustModal;
      'plus.plus': PlusPlus;
      'pricing.plan': PricingPlan;
      'promo.promo': PromoPromo;
      'testimonial.testimonials': TestimonialTestimonials;
      'venta-item.venta-item': VentaItemVentaItem;
      'video-id.youtube-video': VideoIdYoutubeVideo;
    }
  }
}
