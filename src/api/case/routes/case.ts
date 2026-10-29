/**
 * case router
 *
 * El core router lo usa /dashboard/operations del frontend: solo los roles del
 * equipo (coordinación y especialistas) llevan permisos sobre `case`, y el
 * controller limita al especialista a sus casos. El paciente nunca entra por
 * aquí, solo por las rutas públicas de `case-paciente.ts`.
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::case.case');
