/**
 * square.js — shared Square client + inventory helpers.
 */

import { SquareClient, SquareEnvironment } from 'square';
import { squareToken } from './settings.js';

export const SOLD_OUT_THRESHOLD = 3; // inventory count ≤ this → sold out

export function squareClient() {
  return new SquareClient({ token: squareToken(), environment: SquareEnvironment.Production });
}

/**
 * Returns a Map of { variation_id → quantity } for IN_STOCK counts at one location.
 * Follows pagination (a batch can return more than one page of counts).
 */
export async function fetchInventoryCounts(client, locationId, variationIds) {
  const counts = new Map();
  const ids = [...new Set(variationIds.filter(Boolean))];
  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    const page = await client.inventory.batchGetCounts({
      catalogObjectIds: ids.slice(i, i + BATCH),
      locationIds:      [locationId],
    });
    for await (const c of page) {
      if (c.state === 'IN_STOCK') counts.set(c.catalogObjectId, parseFloat(c.quantity || '0'));
    }
  }
  return counts;
}
