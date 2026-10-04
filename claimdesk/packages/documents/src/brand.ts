/**
 * Brand tokens for every generated document (BLUEPRINT §9) and the web app.
 * Document palette comes from the live letterhead; the logo keeps its own colours (print/README.md).
 */
export const brand = {
  company: {
    registeredName: 'Courtesy Cars Group UK Ltd',
    tradingName: 'Courtesy Cars UK',
    companyNumber: '17430389',
    tagline: 'Accident Management Specialists',
    services: ['Accident Claims', 'Credit Hire', 'Recovery', 'Storage'],
    claimsEmail: 'claims@courtesycars.net',
    accidentLine24h: '020 7052 5403',
    registeredOffice: '', // set from settings; never a legacy address
    vatNumber: '', // set from settings when registered
    icoRegistration: '', // set from settings
    statusLine:
      'Courtesy Cars Group UK Ltd provides accident management, credit hire, recovery and storage services. It is not a firm of solicitors and is not regulated by the SRA.'
  },
  /** Part 6 Companies Act 2006 trading disclosures — rendered in every document footer. */
  tradingDisclosure(registeredOffice: string): string {
    return `Courtesy Cars Group UK Ltd. Registered in England and Wales, company number 17430389. Registered office: ${registeredOffice || '[registered office]'}.`;
  },
  colours: {
    navy: '#0D1C50',
    accent: '#04347F',
    gold: '#B8901F',
    silver: '#8A8F9B',
    tint: '#F4F6FA',
    ink: '#111111',
    rule: '#D9DCE3',
    // logo colours (do not recolour the logo)
    logoNavy: '#072647',
    logoBlue: '#1466D2',
    logoGrey: '#A9A9A9'
  },
  typography: {
    // Calibri on Windows/Office; metric-compatible fallbacks elsewhere.
    fontStack: "Calibri, Carlito, 'Liberation Sans', Arial, Helvetica, sans-serif",
    bodyPt: 10.5,
    smallPt: 8.5,
    h1Pt: 16,
    h2Pt: 12.5
  },
  page: {
    size: 'A4' as const,
    marginMm: { top: 18, right: 18, bottom: 20, left: 18 }
  },
  /** LDUK partner-mark slot stays disabled until a signed partnership record is uploaded. */
  partnerMarkEnabled: false,
  /** Strings that must never appear in any outgoing document (BLUEPRINT §3.10). */
  legacy: {
    blockedStrings: ['Car Flex', 'Carflex Ltd', '17360033', '66 Paul Street', 'EC2A 4PX', 'courtesycarsuk.co.uk'],
    allowedExactCase: ['CARFLEX LTD'],
    bannedPhrases: [
      'ignore any offer of a courtesy car',
      'do not accept a vehicle from the insurer',
      'our solicitors',
      'we act as your solicitors',
      'regulated by the SRA',
      'legal advice from our lawyers'
    ]
  }
} as const;

export type Brand = typeof brand;
