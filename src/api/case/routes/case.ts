/**
 * case router
 *
 * El core router queda registrado para el admin, pero ningún rol del
 * users-permissions debe tener permisos sobre `case`: el paciente solo entra
 * por las rutas públicas de `case-paciente.ts`.
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::case.case');
