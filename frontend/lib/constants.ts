// lib/constants.ts

// Normalisation de l'URL pour éviter les problèmes de pare-feu et de slashs
export const WOO_URL = (process.env.NEXT_PUBLIC_WOO_URL || 'https://www.miadmarket.com').replace(/\/$/, '');
export const WOO_CK = process.env.WOO_CONSUMER_KEY;
export const WOO_CS = process.env.WOO_CONSUMER_SECRET;