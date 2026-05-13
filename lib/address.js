// Address normalization for property dedup, plus freetext parsing.
// USPS-style suffix abbreviation + uppercase + collapse whitespace + strip punctuation.
// Not perfect, but catches the obvious dupes (street/St, road/Rd, etc.).

const SUFFIX_MAP = {
  STREET: 'ST', ST: 'ST',
  AVENUE: 'AVE', AVE: 'AVE', AV: 'AVE',
  ROAD: 'RD', RD: 'RD',
  DRIVE: 'DR', DR: 'DR',
  BOULEVARD: 'BLVD', BLVD: 'BLVD', BOULV: 'BLVD',
  LANE: 'LN', LN: 'LN',
  COURT: 'CT', CT: 'CT',
  PLACE: 'PL', PL: 'PL',
  CIRCLE: 'CIR', CIR: 'CIR',
  TERRACE: 'TER', TER: 'TER',
  HIGHWAY: 'HWY', HWY: 'HWY',
  PARKWAY: 'PKWY', PKWY: 'PKWY',
  TRAIL: 'TRL', TRL: 'TRL',
  WAY: 'WAY'
};

// Lowercased set used by parseFreetextAddress to find the line1/city seam
// when no commas separate them.
const STREET_SUFFIX_TOKENS = new Set([
  'st','street','ave','avenue','av','rd','road','dr','drive',
  'blvd','boulevard','ln','lane','ct','court','pl','place',
  'cir','circle','way','pkwy','parkway','hwy','highway',
  'ter','terrace','trl','trail'
]);

const DIRECTIONAL_MAP = {
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW'
};

function normalizeAddress({ address_line1, unit, city, state, zip }) {
  const line1 = (address_line1 || '').toString().toUpperCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = line1.split(' ').map(tok => {
    if (DIRECTIONAL_MAP[tok]) return DIRECTIONAL_MAP[tok];
    if (SUFFIX_MAP[tok])      return SUFFIX_MAP[tok];
    return tok;
  });

  const normalizedLine = tokens.join(' ');
  const normUnit  = (unit  || '').toString().toUpperCase().replace(/[#.\s]/g, '').trim();
  const normCity  = (city  || '').toString().toUpperCase().replace(/\s+/g, ' ').trim();
  const normState = (state || '').toString().toUpperCase().trim();
  const normZip   = (zip   || '').toString().replace(/\D/g, '').slice(0, 5);

  return [normalizedLine, normUnit, normCity, normState, normZip]
    .filter(Boolean)
    .join('|');
}

// Parse a freetext address into Prop Spot's structured columns. Handles:
//   "123 Main St, Springfield, IL 62701"           — comma-separated
//   "123 Main St, Springfield, IL 62701, USA"      — Google Places format
//   "123 main st, springfield il 62701"            — lowercase, partial commas
//   "123 Main St Springfield IL 62701"             — no commas
//   "123 Main St Springfield IL"                   — no zip
//
// `ok=true` when ZIP was extracted, `false` otherwise — callers can use that
// to flag rows for manual review.
function parseFreetextAddress(text) {
  if (!text || !text.trim()) {
    return { address_line1: '(unknown)', city: 'UNKNOWN', state: 'XX', zip: '00000', ok: false };
  }

  // Strip trailing ", USA" / " USA" / " USA."
  const raw = text.trim().replace(/,?\s+USA\.?\s*$/i, '').trim();

  // Peel state + zip off the end.
  let m = raw.match(/^(.*?)[,\s]+([A-Za-z]{2})[,\s]+(\d{5})(?:-\d{4})?\s*$/);
  let body, state, zip;
  if (m) {
    body  = m[1].trim().replace(/,\s*$/, '');
    state = m[2].toUpperCase();
    zip   = m[3];
  } else {
    m = raw.match(/^(.*?)[,\s]+([A-Za-z]{2})\s*$/);
    if (m) {
      body  = m[1].trim().replace(/,\s*$/, '');
      state = m[2].toUpperCase();
      zip   = null;
    } else {
      return { address_line1: raw.slice(0, 200), city: 'UNKNOWN', state: 'XX', zip: '00000', ok: false };
    }
  }

  // Split body → line1 + city.
  const bodyParts = body.split(',').map(s => s.trim()).filter(Boolean);
  let line1, city;
  if (bodyParts.length >= 2) {
    city  = bodyParts[bodyParts.length - 1];
    line1 = bodyParts.slice(0, -1).join(', ');
  } else {
    const words = body.split(/\s+/);
    let suffixIdx = -1;
    for (let i = 0; i < words.length; i++) {
      const w = words[i].replace(/[.,]/g, '').toLowerCase();
      if (STREET_SUFFIX_TOKENS.has(w)) suffixIdx = i;
    }
    if (suffixIdx >= 0 && suffixIdx < words.length - 1) {
      line1 = words.slice(0, suffixIdx + 1).join(' ');
      city  = words.slice(suffixIdx + 1).join(' ');
    } else if (words.length >= 2) {
      city  = words.slice(-1).join(' ');
      line1 = words.slice(0, -1).join(' ');
    } else {
      line1 = body;
      city  = 'UNKNOWN';
    }
  }

  // Title-case the city for consistency.
  city = (city || 'UNKNOWN').replace(/\b\w/g, c => c.toUpperCase());

  return {
    address_line1: line1 || raw.slice(0, 200),
    city,
    state,
    zip: zip || '00000',
    ok: zip !== null
  };
}

module.exports = { normalizeAddress, parseFreetextAddress };
