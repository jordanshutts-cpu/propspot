// Address normalization for property dedup.
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

module.exports = { normalizeAddress };
