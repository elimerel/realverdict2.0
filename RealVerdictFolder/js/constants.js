/** Shared app constants — underwriting presets and defaults. */

export const STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];

export const MARKET_DEFAULTS = {
  MORTGAGE_30Y_FRM: 6.81,
  NJ_PROP_TAX_RATE: 0.0223,
  DEFAULT_PROP_TAX_RATE: 0.012,
};

export const RATES = {
  INSURANCE:    0.005,
  MAINTENANCE:  0.010,
  VACANCY:      0.08,
  MANAGEMENT:   0.08,
};

export const SPX_ANNUAL = 1.103;
export const RATE_SLIDER_MAX = 12;
export const SAVED_KEY = 'rv_analyses_v2';
export const LAST_WIZARD_STEP = 2;

export const DEF = {
  step: 0,
  addr: { street: '', city: '', state: '', zip: '', country: 'United States' },
  price: 0, units: 1, downPct: 20,
  rate: MARKET_DEFAULTS.MORTGAGE_30Y_FRM,
  rents: [], taxes: 0, insurance: 0, maintenance: 0,
  vacancy: 0, management: 0, otherExp: 0,
  period: 'mo', appreciation: 3,
};

export const SCREENING_PRESETS = {
  aggressive: {
    id: 'aggressive',
    label: 'Aggressive',
    tagline: 'Looser bars — more deals look “good.” Useful when your market rarely hits textbook yields.',
    tiers: {
      strong: { minCoc: 10, minCap: 7, minDscr: 1.15 },
      good:   { minCoc: 6, minCap: 5 },
      border: { minCoc: 2, minCap: 4.5 },
    },
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    tagline: 'Default triage mix — good starting point before comps and inspection.',
    tiers: {
      strong: { minCoc: 12, minCap: 8, minDscr: 1.25 },
      good:   { minCoc: 8, minCap: 6 },
      border: { minCoc: 4, minCap: 5 },
    },
  },
  conservative: {
    id: 'conservative',
    label: 'Conservative',
    tagline: 'Tighter bars — fewer “Strong” labels; closer to how many pros screen deals.',
    tiers: {
      strong: { minCoc: 14, minCap: 9, minDscr: 1.35 },
      good:   { minCoc: 10, minCap: 7 },
      border: { minCoc: 5, minCap: 5.5 },
    },
  },
};

export const ADDR_STATE_FULL = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming' };
