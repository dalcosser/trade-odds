/**
 * Central watchlist loader.
 * Edit lib/watchlist.json to add/remove tickers — all scripts pick up changes automatically.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(resolve(__dir, 'watchlist.json'), 'utf-8'));

export const WATCHLIST = data.watchlist;
export const MAG7 = data.mag7;
export const EXTRAS = data.extras;
export const UNIVERSE = [...new Set([...WATCHLIST, ...MAG7, ...EXTRAS])];
export const SHORT_TICKERS = new Set(data.shortTickers || []);
