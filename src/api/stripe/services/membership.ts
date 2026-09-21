'use strict';

/**
 * Una sola función decide si un usuario tiene la membresía vigente.
 *
 * Vive aparte del handler a propósito: `membershipActive` es lo que lee el
 * checkout para aplicar el precio de miembro, así que la regla tiene que estar
 * en un solo lugar y ser fácil de auditar.
 */

// Estados de Stripe que conceden el beneficio.
const CONCEDEN = new Set(['active', 'trialing']);

/**
 * `past_due` también concede, y es deliberado: Stripe está reintentando el
 * cobro (Smart Retries, unas tres semanas). Cortarle el descuento a alguien
 * porque se le venció la tarjeta, mientras Stripe todavía lo intenta, es mal
 * producto por un beneficio que cuesta poco. El corte real llega solo cuando
 * Stripe agota los reintentos y manda `canceled`.
 */
const GRACIA = new Set(['past_due']);

/**
 * `manual` es la red de seguridad: miembros de cortesía, empleados, y los que
 * se dieron de alta a mano antes de que existiera este webhook. Ningún evento
 * de Stripe puede degradarlos.
 */
export function derivarMembresia(status: string | null, manual: boolean): boolean {
  if (manual === true) return true;
  if (!status) return false;
  return CONCEDEN.has(status) || GRACIA.has(status);
}
