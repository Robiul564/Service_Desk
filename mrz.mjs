/**
 * ICAO Doc 9303 Part 4 — TD3 Passport MRZ Parser, Validator, Consensus & VIZ Cross-Verifier
 *
 * SCOPE: TD3 PASSPORTS ONLY (exactly 2 lines x 44 characters).
 * TD1 / TD2 and any non-44-char or check-digit-failing scans are strictly rejected.
 *
 * TD3 Layout (1-indexed positions):
 * Line 1 (44 chars):
 *   pos 1      Document type ("P")
 *   pos 2      Type subcode ([A-Z<])
 *   pos 3-5    Issuing state (ISO 3166-1 alpha-3 or ICAO special code)
 *   pos 6-44   Name field: SURNAME<<GIVEN<NAMES<<<<< (39 chars)
 * Line 2 (44 chars):
 *   pos 1-9    Passport number          pos 10 check digit
 *   pos 11-13  Nationality (ISO 3166-1 alpha-3 or ICAO special code)
 *   pos 14-19  Date of birth YYMMDD     pos 20 check digit
 *   pos 21     Sex (M / F / <)
 *   pos 22-27  Expiry date YYMMDD       pos 28 check digit
 *   pos 29-42  Personal number          pos 43 check digit
 *   pos 44     Composite check digit (over pos 1-10, 14-20, 22-43)
 */

const WEIGHTS = [7, 3, 1];

/**
 * Complete ISO 3166-1 alpha-3 country codes + official ICAO Doc 9303 Part 3 special codes.
 */
export const VALID_ICAO_COUNTRY_CODES = new Set([
  // ISO 3166-1 alpha-3 (249 official codes)
  "ABW", "AFG", "AGO", "AIA", "ALA", "ALB", "AND", "ARE", "ARG", "ARM", "ASM", "ATA", "ATF", "ATG", "AUS", "AUT", "AZE",
  "BDI", "BEL", "BEN", "BES", "BFA", "BGD", "BGR", "BHR", "BHS", "BIH", "BLM", "BLR", "BLZ", "BMU", "BOL", "BRA", "BRB", "BRN", "BTN", "BVT", "BWA",
  "CAF", "CAN", "CCK", "CHE", "CHL", "CHN", "CIV", "CMR", "COD", "COG", "COK", "COL", "COM", "CPV", "CRI", "CUB", "CUW", "CXR", "CYM", "CYP", "CZE",
  "DEU", "DJI", "DMA", "DNK", "DOM", "DZA",
  "ECU", "EGY", "ERI", "ESH", "ESP", "EST", "ETH",
  "FIN", "FJI", "FLK", "FRA", "FRO", "FSM",
  "GAB", "GBR", "GEO", "GGY", "GHA", "GIB", "GIN", "GLP", "GMB", "GNB", "GNQ", "GRC", "GRD", "GRL", "GTM", "GUF", "GUM", "GUY",
  "HKG", "HMD", "HND", "HRV", "HTI", "HUN",
  "IDN", "IMN", "IND", "IOT", "IRL", "IRN", "IRQ", "ISL", "ISR", "ITA",
  "JAM", "JEY", "JOR", "JPN",
  "KAZ", "KEN", "KGZ", "KHM", "KIR", "KNA", "KOR", "KWT",
  "LAO", "LBN", "LBR", "LBY", "LCA", "LIE", "LKA", "LSO", "LTU", "LUX", "LVA",
  "MAC", "MAF", "MAR", "MCO", "MDA", "MDG", "MDV", "MEX", "MHL", "MKD", "MLI", "MLT", "MMR", "MNE", "MNG", "MNP", "MOZ", "MRT", "MSR", "MTQ", "MUS", "MWI", "MYS", "MYT",
  "NAM", "NCL", "NER", "NFK", "NGA", "NIC", "NIU", "NLD", "NOR", "NPL", "NRU", "NZL",
  "OMN",
  "PAK", "PAN", "PCN", "PER", "PHL", "PLW", "PNG", "POL", "PRI", "PRK", "PRT", "PRY", "PSE", "PYF",
  "QAT",
  "REU", "ROU", "RUS", "RWA",
  "SAU", "SDN", "SEN", "SGP", "SGS", "SHN", "SJM", "SLB", "SLE", "SLV", "SMR", "SOM", "SPM", "SRB", "SSD", "STP", "SUR", "SVK", "SVN", "SWE", "SWZ", "SXM", "SYC", "SYR",
  "TCA", "TCD", "TGO", "THA", "TJK", "TKL", "TKM", "TLS", "TON", "TTO", "TUN", "TUR", "TUV", "TWN", "TZA",
  "UGA", "UKR", "UMI", "URY", "USA", "UZB",
  "VAT", "VCT", "VEN", "VGB", "VIR", "VNM", "VUT",
  "WLF", "WSM",
  "YEM",
  "ZAF", "ZMB", "ZWE",
  // Official ICAO Doc 9303 Part 3 special & organizational codes
  "D<<", // Germany (ICAO special 1-letter code padded with <<)
  "GBD", // British Overseas Territories Citizen
  "GBN", // British National (Overseas)
  "GBO", // British Overseas Citizen
  "GBP", // British Protected Person
  "GBS", // British Subject
  "UNO", // United Nations Organization
  "UNA", // United Nations Specialized Agency
  "UNK", // UNMIK Kosovo
  "RKS", // Republic of Kosovo
  "EUE", // European Union
  "XBA", // African Development Bank
  "XIM", // African Export-Import Bank
  "XCC", // Caribbean Community (CARICOM)
  "XCE", // Council of Europe
  "XCO", // Common Market for Eastern and Southern Africa (COMESA)
  "XEC", // Economic Community of West African States (ECOWAS)
  "XPO", // International Criminal Police Organization (INTERPOL)
  "XOM", // Sovereign Military Order of Malta
  "XXA", // Stateless person (1954 Convention)
  "XXB", // Refugee (1951 Convention)
  "XXC", // Refugee (other)
  "XXX", // Unspecified nationality
  "UTO"  // Utopia (ICAO Doc 9303 official specimen state)
]);

const NATIONALITY_LABELS = {
  BGD: "Bangladeshi",
  MYS: "Malaysian",
  IND: "Indian",
  PAK: "Pakistani",
  NPL: "Nepali",
  IDN: "Indonesian",
  MMR: "Myanmar",
  PHL: "Filipino",
  VNM: "Vietnamese",
  LKA: "Sri Lankan",
  "D<<": "German",
  DEU: "German",
  GBR: "British",
  USA: "American",
  SGP: "Singaporean",
  SAU: "Saudi",
  ARE: "Emirati",
  QAT: "Qatari",
  OMN: "Omani",
  KWT: "Kuwaiti",
  BHR: "Bahraini"
};

/**
 * Compute ICAO Doc 9303 check digit (weights 7-3-1, A=10..Z=35, "<"=0).
 * @param {string} value
 * @returns {number} 0..9
 */
export function checkDigit(value) {
  let total = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    let num = 0;
    if (c === "<") {
      num = 0;
    } else if (c >= "0" && c <= "9") {
      num = c.charCodeAt(0) - 48;
    } else if (c >= "A" && c <= "Z") {
      num = c.charCodeAt(0) - 55;
    } else {
      return -1; // Invalid MRZ character
    }
    total += num * WEIGHTS[i % 3];
  }
  return total % 10;
}

/**
 * OCR numeric-field confusion correction ONLY (O->0, I->1, B->8, S->5, Z->2, G->6).
 * NEVER call this on the name field, issuing state, or nationality.
 */
function toNumericField(value) {
  return String(value || "")
    .replace(/O/g, "0")
    .replace(/I/g, "1")
    .replace(/B/g, "8")
    .replace(/S/g, "5")
    .replace(/Z/g, "2")
    .replace(/G/g, "6");
}

/**
 * Check if a 3-char ICAO country code is valid (ISO 3166-1 alpha-3 or ICAO special code).
 */
export function isValidIcaoCountryCode(code) {
  if (typeof code !== "string" || code.length !== 3) return false;
  if (VALID_ICAO_COUNTRY_CODES.has(code)) return true;
  // Normalize single-letter Germany code if passed as "D" vs "D<<"
  return false;
}

/**
 * Parse and validate a real YYMMDD calendar date with proper century resolution.
 * - DOB: must NOT be in the future (compared against referenceDate, defaults to today UTC).
 * - Expiry: resolved relative to referenceDate (-30 to +50 year window) and checked against DOB if provided.
 */
export function parseMrzDate(yymmdd, { isDob = false, referenceDate = new Date(), dobIso = null } = {}) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const month = Number(yymmdd.slice(2, 4));
  const day = Number(yymmdd.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const refYear = referenceDate.getUTCFullYear();
  const refMonth = referenceDate.getUTCMonth() + 1;
  const refDay = referenceDate.getUTCDate();
  const centuryBase = Math.floor(refYear / 100) * 100;

  let year = centuryBase + yy;
  if (isDob) {
    // DOB must never be in the future relative to today
    const isFuture =
      year > refYear ||
      (year === refYear && month > refMonth) ||
      (year === refYear && month === refMonth && day > refDay);
    if (isFuture) year -= 100;
    // Sanity bound: human DOB cannot be > 125 years ago
    if (refYear - year > 125) return null;
  } else {
    // Passport expiry: typically within -30 to +50 years of today
    if (year > refYear + 50) year -= 100;
    else if (year < refYear - 30) year += 100;
  }

  // Verify real calendar date (catches Feb 29 on non-leap years, Apr 31, etc.)
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }

  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!isDob && dobIso && iso <= dobIso) {
    return null; // Expiry date cannot precede or equal date of birth
  }
  return iso;
}

/**
 * Clean OCR filler-character misreads (< read as K, C, L, S, E, I) strictly in
 * the trailing filler zone of the 39-character TD3 name field (pos 6-44).
 *
 * Rules grounded in ICAO Doc 9303 Part 4:
 * 1. NEVER apply digit-to-letter or letter-to-digit correction. Digits invalidate the name.
 * 2. Filler runs after the name are ALWAYS "<", never letters.
 * 3. In ICAO TD3:
 *    - Surname starts at index 0.
 *    - Surname and Given Names are separated by EXACTLY TWO "<" ("<<").
 *    - Three or more consecutive "<" ("<<<") can ONLY occur in the trailing filler zone.
 *    - Any second "<<" (after the first "<<" separator) can ONLY occur in the trailing filler zone.
 *    - No real name ends with a trailing run of 3+ identical filler-confusable letters
 *      (KKK, CCC, LLL, SSS, EEE, III) touching the end of the 39-char field or right before filler.
 *    - Trailing alternating noise patterns reaching char 39 (e.g. "<K<K<K<K<", "<KK<C<L<") are filler.
 *    - Single-letter middle initials (e.g. "SMITH<<JOHN<K<<<<<<<<<<<<") are preserved!
 */
export function cleanTd3NameFillerNoise(raw39) {
  let s = raw39;

  // Step 1: Any run of 3+ consecutive "<" marks the start of the trailing filler zone.
  // Everything from that "<<<" to index 39 MUST be "<" (fixes "<<<K<<KK<C<L<E<I<").
  const tripleIdx = s.indexOf("<<<");
  if (tripleIdx !== -1) {
    s = s.slice(0, tripleIdx) + "<".repeat(39 - tripleIdx);
  }

  // Step 2: If there is a first "<<" separator and a SECOND "<<" later in the field,
  // everything from the second "<<" to index 39 MUST be "<" (fixes "<<ANNA<MARIA<<K<C<K<").
  const firstSep = s.indexOf("<<");
  if (firstSep !== -1) {
    const secondSep = s.indexOf("<<", firstSep + 2);
    if (secondSep !== -1) {
      s = s.slice(0, secondSep) + "<".repeat(39 - secondSep);
    }
  }

  // Step 3: Clean trailing OCR filler noise touching the end of the 39-char line (index 38).
  // Loop until stable because stripping trailing "<" or "KKKK" can expose an adjacent noise segment.
  let prev;
  do {
    prev = s;
    const trimmedLen = s.replace(/<+$/, "").length;
    const head = s.slice(0, trimmedLen);
    const trailingFillers = 39 - trimmedLen;

    // 3a. Run of 3+ identical filler-confusable chars at the very end of the non-filler text
    //     e.g. "ANNA<MARIAKKKKKKKKKKKKKKKKKKK" or "ANNA<MARIAKKKK<<<<<<"
    const identicalRunMatch = head.match(/([KCLSEI])\1{2,}$/);
    if (identicalRunMatch) {
      // Only strip if it's touching end-of-line OR preceded by "<" OR adjacent to trailing "<"
      const runLen = identicalRunMatch[0].length;
      const runStart = head.length - runLen;
      const precedesFillerOrEol = trailingFillers > 0 || runStart + runLen === 39;
      if (precedesFillerOrEol) {
        s = head.slice(0, runStart) + "<".repeat(39 - runStart);
        continue;
      }
    }

    // 3b. Trailing mixed filler-noise tail of length >= 4 consisting exclusively of "<" and
    //     {K, C, L, S, E, I} that contains at least two "<" separators (e.g. "<K<K<K<K<",
    //     "<K<C<L<K", "<KK<K<") when touching the end of the 39-char line (trailingFillers <= 1)
    //     or when every token is confusable and >= 3 tokens long.
    //     NOTE: A legitimate middle initial like "JOHN<K" (1 token) or "JOHN<K<L" followed by "<<"
    //     is NOT matched because of the >= 3 alternating tokens requirement at EOL.
    const alternatingMatch = head.match(/(?:<+[KCLSEI]{1,2}){3,}$/);
    if (alternatingMatch) {
      const matchStart = head.length - alternatingMatch[0].length;
      s = head.slice(0, matchStart) + "<".repeat(39 - matchStart);
      continue;
    }

    // 3c. Trailing double-K ("<KK") immediately adjacent to trailing filler "<<" (e.g. "MARIA<KK<<<<")
    //     No valid given name is "KK".
    if (trailingFillers >= 1) {
      const doubleKMatch = head.match(/<K{2,}$/);
      if (doubleKMatch) {
        const matchStart = head.length - doubleKMatch[0].length;
        s = head.slice(0, matchStart) + "<".repeat(39 - matchStart);
        continue;
      }
    }

    // 3d. Re-check second "<<" if newly exposed
    const fSep = s.indexOf("<<");
    if (fSep !== -1) {
      const sSep = s.indexOf("<<", fSep + 2);
      if (sSep !== -1) {
        s = s.slice(0, sSep) + "<".repeat(39 - sSep);
      }
    }
  } while (s !== prev);

  return s;
}

/**
 * Parse the TD3 name field (Line 1, characters 6-44, 39 chars total).
 *
 * - NEVER converts digits to letters or letters to digits.
 * - Rejects any digit 0-9 found in the name field.
 * - Cleans OCR filler noise (< read as K/C/L/S/E/I) in the trailing filler zone.
 * - Splits on the FIRST "<<": left = surname, right = given names.
 * - Converts single "<" inside surname/given names into single spaces.
 * - Detects 39-character truncation.
 * - Returns surname and given_names as separate fields.
 *
 * @param {string} line1 - Full 44-char TD3 Line 1
 */
export function parseTd3Name(line1) {
  if (typeof line1 !== "string" || line1.length !== 44) {
    return { valid: false, error: "TD3 Line 1 must be exactly 44 characters." };
  }

  // Extract strictly positions 6-44 (0-indexed 5..44 => 39 characters)
  const rawNameField = line1.slice(5, 44);

  // Strict rule: NEVER apply digit-to-letter correction in name. Any digit is an OCR error.
  if (/[0-9]/.test(rawNameField)) {
    return {
      valid: false,
      error: "MRZ name field contains invalid digit(s). Rescan required."
    };
  }
  if (!/^[A-Z<]{39}$/.test(rawNameField)) {
    return {
      valid: false,
      error: "MRZ name field contains invalid characters."
    };
  }

  // Clean trailing OCR filler noise (< misread as K/C/L/S/E/I)
  const cleaned39 = cleanTd3NameFillerNoise(rawNameField);

  // Detect if name hit the 39-char ICAO truncation boundary (no trailing filler left)
  const truncated = !cleaned39.endsWith("<");

  // Split on the FIRST "<<"
  const sepIndex = cleaned39.indexOf("<<");
  let surnameRaw = "";
  let givenRaw = "";

  if (sepIndex === -1) {
    // No "<<" separator found at all — only valid if name is a 39-char truncated single surname
    // or all characters are letters/single "<". Flag as truncated/single-identifier.
    surnameRaw = cleaned39.replace(/<+$/, "");
    givenRaw = "";
  } else {
    surnameRaw = cleaned39.slice(0, sepIndex);
    const afterSep = cleaned39.slice(sepIndex + 2);
    // If afterSep begins with "<" (meaning "<<<"), there are NO given names (single-name passport)
    if (afterSep.startsWith("<")) {
      givenRaw = "";
    } else {
      // Trim trailing "<" fillers
      givenRaw = afterSep.replace(/<+$/, "");
    }
  }

  // Inside each part, single "<" represents a space (or transliterated hyphen/apostrophe)
  const surname = surnameRaw.replace(/</g, " ").replace(/\s+/g, " ").trim();
  const given_names = givenRaw.replace(/</g, " ").replace(/\s+/g, " ").trim();

  if (!surname) {
    return {
      valid: false,
      error: "Surname could not be extracted from MRZ Line 1."
    };
  }

  const full_name = given_names ? `${given_names} ${surname}` : surname;

  return {
    valid: true,
    surname,
    given_names,
    full_name,
    truncated,
    cleaned_raw: cleaned39,
    error: null
  };
}

/**
 * Attempt targeted OCR numeric correction on a single check-digit character.
 */
function parseCheckDigitChar(ch, allowFillerZero = false) {
  if (allowFillerZero && ch === "<") return 0;
  const fixed = toNumericField(ch);
  if (!/^[0-9]$/.test(fixed)) return null;
  return Number(fixed);
}

/**
 * Attempt safe OCR numeric correction on an alphanumeric field (passport number or personal number)
 * ONLY when the raw field fails its check digit. Re-verifies the check digit after every candidate.
 */
function repairNumericPositionsWithCheck(rawField, expectedDigit) {
  // 1. Raw field already passes? Return immediately with zero mutations!
  if (checkDigit(rawField) === expectedDigit) {
    return { value: rawField, repaired: false, valid: true };
  }

  // 2. Try converting digits in the numeric suffix (e.g. passport number after 1-2 alpha prefix chars)
  for (const prefixLen of [2, 1, 0]) {
    const candidate = rawField.slice(0, prefixLen) + toNumericField(rawField.slice(prefixLen));
    if (candidate !== rawField && checkDigit(candidate) === expectedDigit) {
      return { value: candidate, repaired: true, valid: true };
    }
  }

  // 3. Try single-character OCR confusion swap (O<->0, I<->1, B<->8, S<->5, Z<->2, G<->6)
  //    in numeric positions (letter->digit and digit->letter for alphanumeric doc numbers),
  //    accepting ONLY if exactly ONE unique correction passes the check digit.
  const swaps = {
    O: "0", "0": "O",
    I: "1", "1": "I",
    B: "8", "8": "B",
    S: "5", "5": "S",
    Z: "2", "2": "Z",
    G: "6", "6": "G"
  };
  const validCandidates = [];
  for (let i = 0; i < rawField.length; i += 1) {
    const alt = swaps[rawField[i]];
    if (!alt) continue;
    const cand = rawField.slice(0, i) + alt + rawField.slice(i + 1);
    if (checkDigit(cand) === expectedDigit) {
      validCandidates.push(cand);
    }
  }
  if (validCandidates.length === 1) {
    return { value: validCandidates[0], repaired: true, valid: true };
  }

  return { value: rawField, repaired: false, valid: false };
}

/**
 * Clean a single raw OCR line: uppercase, normalize angle brackets, strip spaces/noise.
 */
export function cleanOcrLine(rawLine) {
  return String(rawLine || "")
    .toUpperCase()
    .replace(/[«‹⟨≤]/g, "<")
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9<]/g, "");
}

/**
 * Validate and parse a strict TD3 pair (2 lines x 44 characters).
 * Returns { valid, errors, checks, data, rawLines }.
 * If ANY check fails, valid = false and data = null (no unchecked data returned).
 */
export function validateTd3Pair(rawLine1, rawLine2, options = {}) {
  const referenceDate = options.referenceDate || new Date();
  const errors = [];

  const line1 = cleanOcrLine(rawLine1);
  const line2 = cleanOcrLine(rawLine2);

  const checks = {
    length: line1.length === 44 && line2.length === 44,
    documentType: false,
    issuingState: false,
    nationality: false,
    name: false,
    passport: false,
    dob: false,
    sex: false,
    expiry: false,
    personal: false,
    composite: false
  };

  if (!checks.length) {
    errors.push(`Expected 2 lines of 44 characters (got ${line1.length} and ${line2.length}).`);
    return { valid: false, errors, checks, data: null, rawLines: [line1, line2] };
  }

  // Line 1 pos 1-2: Document type ("P" + [A-Z<])
  checks.documentType = line1[0] === "P" && /^[A-Z<]$/.test(line1[1]);
  if (!checks.documentType) {
    errors.push(`Invalid TD3 passport document code "${line1.slice(0, 2)}" (must start with "P").`);
  }

  // Line 1 pos 3-5: Issuing state (strict ISO 3166-1 alpha-3 / ICAO special code, NO digit->letter mutation)
  const issuingState = line1.slice(2, 5);
  checks.issuingState = isValidIcaoCountryCode(issuingState);
  if (!checks.issuingState) {
    errors.push(`Invalid issuing state code "${issuingState}".`);
  }

  // Line 1 pos 6-44: Name parsing (no digit<->letter correction!)
  const parsedName = parseTd3Name(line1);
  checks.name = parsedName.valid;
  if (!parsedName.valid) {
    errors.push(parsedName.error);
  }

  // Line 2 pos 1-10: Passport number (9 chars) + check digit (pos 10)
  const rawPassport = line2.slice(0, 9);
  const passportCheckChar = line2[9];
  const passportExpected = parseCheckDigitChar(passportCheckChar, false);
  let verifiedPassport = rawPassport;
  if (passportExpected !== null) {
    const repaired = repairNumericPositionsWithCheck(rawPassport, passportExpected);
    verifiedPassport = repaired.value;
    checks.passport = repaired.valid;
  }
  if (!checks.passport) {
    errors.push("Passport number check digit failed.");
  }

  // Line 2 pos 11-13: Nationality (strict ISO 3166-1 alpha-3 / ICAO special code)
  const nationalityCode = line2.slice(10, 13);
  checks.nationality = isValidIcaoCountryCode(nationalityCode);
  if (!checks.nationality) {
    errors.push(`Invalid nationality code "${nationalityCode}".`);
  }

  // Line 2 pos 14-20: Date of birth (6 digits) + check digit (pos 20)
  const dobRaw = toNumericField(line2.slice(13, 19));
  const dobExpected = parseCheckDigitChar(line2[19], false);
  const dobCheckPass = /^\d{6}$/.test(dobRaw) && dobExpected !== null && checkDigit(dobRaw) === dobExpected;
  const dobIso = dobCheckPass ? parseMrzDate(dobRaw, { isDob: true, referenceDate }) : null;
  checks.dob = dobCheckPass && Boolean(dobIso);
  if (!dobCheckPass) {
    errors.push("Date of birth check digit failed.");
  } else if (!dobIso) {
    errors.push(`Invalid date of birth "${dobRaw}".`);
  }

  // Line 2 pos 21: Sex (M / F / <)
  const sexRaw = line2[20];
  checks.sex = sexRaw === "M" || sexRaw === "F" || sexRaw === "<";
  if (!checks.sex) {
    errors.push(`Invalid sex indicator "${sexRaw}" (must be M, F, or <).`);
  }

  // Line 2 pos 22-28: Expiry date (6 digits) + check digit (pos 28)
  const expiryRaw = toNumericField(line2.slice(21, 27));
  const expiryExpected = parseCheckDigitChar(line2[27], false);
  const expiryCheckPass = /^\d{6}$/.test(expiryRaw) && expiryExpected !== null && checkDigit(expiryRaw) === expiryExpected;
  const expiryIso = expiryCheckPass ? parseMrzDate(expiryRaw, { isDob: false, referenceDate, dobIso }) : null;
  checks.expiry = expiryCheckPass && Boolean(expiryIso);
  if (!expiryCheckPass) {
    errors.push("Expiry date check digit failed.");
  } else if (!expiryIso) {
    errors.push(`Invalid expiry date "${expiryRaw}".`);
  }

  // Line 2 pos 29-43: Personal number (14 chars) + check digit (pos 43)
  const rawPersonal = line2.slice(28, 42);
  const isPersonalEmpty = /^<+$/.test(rawPersonal);
  const personalExpected = parseCheckDigitChar(line2[42], isPersonalEmpty);
  let verifiedPersonal = rawPersonal;
  if (personalExpected !== null) {
    const repairedPersonal = repairNumericPositionsWithCheck(rawPersonal, personalExpected);
    verifiedPersonal = repairedPersonal.value;
    checks.personal = repairedPersonal.valid;
  }
  if (!checks.personal) {
    errors.push("Personal number check digit failed.");
  }

  // Line 2 pos 44: Composite check digit over pos 1-10, 14-20, 22-43
  // Note: If personal number is empty and pos 43 was "<", keep "<" in composite source (value 0).
  const personalCheckDigitCharForComposite = isPersonalEmpty && line2[42] === "<"
    ? "<"
    : personalExpected !== null ? String(personalExpected) : line2[42];

  const compositeSource =
    verifiedPassport +
    (passportExpected !== null ? String(passportExpected) : line2[9]) +
    dobRaw +
    (dobExpected !== null ? String(dobExpected) : line2[19]) +
    expiryRaw +
    (expiryExpected !== null ? String(expiryExpected) : line2[27]) +
    verifiedPersonal +
    personalCheckDigitCharForComposite;

  const compositeExpected = parseCheckDigitChar(line2[43], false);
  checks.composite = compositeExpected !== null && checkDigit(compositeSource) === compositeExpected;
  if (!checks.composite) {
    errors.push("Composite check digit failed.");
  }

  const allValid = Object.values(checks).every(Boolean);
  if (!allValid) {
    return { valid: false, errors, checks, data: null, rawLines: [line1, line2] };
  }

  const normalizedLine1 = line1.slice(0, 5) + parsedName.cleaned_raw;
  const normalizedLine2 =
    verifiedPassport +
    String(passportExpected) +
    nationalityCode +
    dobRaw +
    String(dobExpected) +
    sexRaw +
    expiryRaw +
    String(expiryExpected) +
    verifiedPersonal +
    personalCheckDigitCharForComposite +
    String(compositeExpected);

  const data = {
    format: "TD3",
    document_type: line1.slice(0, 2).replace(/</g, ""),
    issuing_state: issuingState === "D<<" ? "D" : issuingState,
    issuing_state_code: issuingState,
    surname: parsedName.surname,
    given_names: parsedName.given_names,
    name: parsedName.full_name,
    name_truncated: parsedName.truncated,
    passport_no: verifiedPassport.replace(/</g, ""),
    nationality_code: nationalityCode === "D<<" ? "D" : nationalityCode,
    nationality: NATIONALITY_LABELS[nationalityCode] || (nationalityCode === "D<<" ? "German" : nationalityCode),
    dob: dobIso,
    sex: sexRaw === "<" ? null : sexRaw,
    sex_raw: sexRaw,
    passport_expiry: expiryIso,
    personal_number: verifiedPersonal.replace(/</g, "") || null,
    mrz_line1: normalizedLine1,
    mrz_line2: normalizedLine2,
    checks,
    score: 5 // All 5 ICAO check digits passed
  };

  return {
    valid: true,
    errors: [],
    checks,
    data,
    rawLines: [normalizedLine1, normalizedLine2]
  };
}

/**
 * Parse raw OCR text to find a strictly valid TD3 passport MRZ (2 lines x 44 chars).
 * Returns full structured result: { valid, errors, checks, data, rawLines }.
 * Rejects TD1/TD2, wrong line lengths, or any failed check digit / validation.
 */
export function parseTd3Mrz(text, options = {}) {
  if (!text || typeof text !== "string") {
    return {
      valid: false,
      errors: ["Empty OCR text."],
      checks: null,
      data: null,
      rawLines: []
    };
  }

  const cleanedLines = text
    .split(/\r?\n/)
    .map(cleanOcrLine)
    .filter(line => line.length > 0);

  // Filter strictly to exact 44-character lines (TD3 standard)
  const exact44Lines = [];
  for (let i = 0; i < cleanedLines.length; i += 1) {
    if (cleanedLines[i].length === 44) {
      exact44Lines.push({ index: i, text: cleanedLines[i] });
    }
  }

  if (exact44Lines.length < 2) {
    const lengths = cleanedLines.map(l => l.length).join(", ") || "none";
    return {
      valid: false,
      errors: [`No TD3 2×44 MRZ pair found (cleaned line lengths: ${lengths}).`],
      checks: null,
      data: null,
      rawLines: cleanedLines
    };
  }

  // Test adjacent 44-char pairs (prefer pairs that were adjacent in OCR output)
  let bestFailure = null;
  let bestFailScore = -1;

  for (let i = 0; i < exact44Lines.length - 1; i += 1) {
    const first = exact44Lines[i];
    const second = exact44Lines[i + 1];
    if (second.index - first.index > 2) continue; // Must be consecutive (allowing at most 1 stray artifact line)

    const result = validateTd3Pair(first.text, second.text, options);
    if (result.valid) {
      return result;
    }

    const passCount = Object.values(result.checks).filter(Boolean).length;
    if (passCount > bestFailScore) {
      bestFailScore = passCount;
      bestFailure = result;
    }
  }

  return bestFailure || {
    valid: false,
    errors: ["No valid adjacent 44-character TD3 MRZ lines found."],
    checks: null,
    data: null,
    rawLines: exact44Lines.map(x => x.text)
  };
}

/**
 * Convenience wrapper matching legacy signature:
 * Returns parsed TD3 data object ONLY when 100% valid; returns null otherwise.
 * Never returns unchecked or invalid data.
 */
export function parseMrz(text, options = {}) {
  const res = parseTd3Mrz(text, options);
  return res.valid ? res.data : null;
}

/**
 * Pad or trim lines that are off by 1-2 chars (e.g. when OCR drops trailing '<').
 */
export function fit(line, n) {
  if (!line || typeof line !== "string") return null;
  if (Math.abs(line.length - n) > 2) return null;
  return (line + "<".repeat(n)).slice(0, n);
}

/**
 * Filter and clean raw OCR lines, retaining only alphanumeric + '<' with length >= 26.
 */
export function cleanLines(text) {
  if (!text || typeof text !== "string") return [];
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const s = cleanOcrLine(raw);
    if (s.length >= 26) {
      lines.push(s);
    }
  }
  return lines;
}

/**
 * Direct TD3 parser matching the python scanner implementation.
 */
export function parseTd3(l1, l2, options = {}) {
  const fitted1 = fit(l1, 44);
  const fitted2 = fit(l2, 44);
  if (!fitted1 || !fitted2 || fitted1[0] !== "P") return null;

  const res = validateTd3Pair(fitted1, fitted2, options);
  if (res.valid && res.data) {
    return {
      format: "TD3",
      document_type: res.data.document_type,
      issuing_country: res.data.issuing_state,
      issuing_state: res.data.issuing_state,
      surname: res.data.surname,
      given_names: res.data.given_names,
      name: res.data.name,
      document_number: res.data.passport_no,
      passport_no: res.data.passport_no,
      nationality: res.data.nationality,
      nationality_code: res.data.nationality_code,
      birth_date: res.data.dob,
      dob: res.data.dob,
      sex: res.data.sex || "X",
      expiry_date: res.data.passport_expiry,
      passport_expiry: res.data.passport_expiry,
      optional_data: res.data.personal_number || "",
      personal_number: res.data.personal_number,
      checks: res.checks,
      all_checks_passed: true,
      rawLines: [fitted1, fitted2]
    };
  }
  return null;
}

/**
 * TD2 parser (2 lines x 36 characters) matching the python scanner implementation.
 */
export function parseTd2(l1, l2, options = {}) {
  const fitted1 = fit(l1, 36);
  const fitted2 = fit(l2, 36);
  if (!fitted1 || !fitted2 || !"ACI".includes(fitted1[0])) return null;

  const doc = fitted2.slice(0, 9);
  const doc_cd = toNumericField(fitted2[9]);
  const dob = toNumericField(fitted2.slice(13, 19));
  const dob_cd = toNumericField(fitted2[19]);
  const exp = toNumericField(fitted2.slice(21, 27));
  const exp_cd = toNumericField(fitted2[27]);
  const opt = fitted2.slice(28, 35);
  const comp_cd = toNumericField(fitted2[35]);

  const composite = doc + doc_cd + dob + dob_cd + exp + exp_cd + opt;
  const checks = {
    document_number: checkDigit(doc) === Number(doc_cd),
    birth_date: checkDigit(dob) === Number(dob_cd) && /^\d{6}$/.test(dob),
    expiry_date: checkDigit(exp) === Number(exp_cd) && /^\d{6}$/.test(exp),
    composite: checkDigit(composite) === Number(comp_cd)
  };

  const allPassed = Object.values(checks).every(Boolean);
  if (!allPassed) return null;

  const parsedName = parseTd3Name(fitted1 + "<".repeat(8));
  const surname = parsedName.valid ? parsedName.surname : fitted1.slice(5).split("<<")[0].replace(/</g, " ").trim();
  const given = parsedName.valid ? parsedName.given_names : (fitted1.slice(5).split("<<")[1] || "").replace(/</g, " ").trim();
  const fullName = given ? `${given} ${surname}`.trim() : surname;

  const natCode = fitted2.slice(10, 13).replace(/0/g, "O").replace(/1/g, "I");
  const countryCode = fitted1.slice(2, 5).replace(/0/g, "O").replace(/1/g, "I");

  return {
    format: "TD2",
    document_type: fitted1.slice(0, 2).replace(/</g, ""),
    issuing_country: countryCode,
    issuing_state: countryCode,
    surname,
    given_names: given,
    name: fullName,
    document_number: doc.replace(/</g, ""),
    passport_no: doc.replace(/</g, ""),
    nationality: NATIONALITY_LABELS[natCode] || natCode,
    nationality_code: natCode,
    birth_date: parseMrzDate(dob, { isDob: true, referenceDate: options.referenceDate }),
    dob: parseMrzDate(dob, { isDob: true, referenceDate: options.referenceDate }),
    sex: "MF".includes(fitted2[20]) ? fitted2[20] : "X",
    expiry_date: parseMrzDate(exp, { isDob: false, referenceDate: options.referenceDate }),
    passport_expiry: parseMrzDate(exp, { isDob: false, referenceDate: options.referenceDate }),
    optional_data: opt.replace(/<+$/, ""),
    checks,
    all_checks_passed: true,
    rawLines: [fitted1, fitted2]
  };
}

/**
 * TD1 parser (3 lines x 30 characters) matching the python scanner implementation.
 */
export function parseTd1(l1, l2, l3, options = {}) {
  const fitted1 = fit(l1, 30);
  const fitted2 = fit(l2, 30);
  const fitted3 = fit(l3, 30);
  if (!fitted1 || !fitted2 || !fitted3) return null;

  const doc = fitted1.slice(5, 14);
  const doc_cd = toNumericField(fitted1[14]);
  const dob = toNumericField(fitted2.slice(0, 6));
  const dob_cd = toNumericField(fitted2[6]);
  const exp = toNumericField(fitted2.slice(8, 14));
  const exp_cd = toNumericField(fitted2[14]);
  const comp_cd = toNumericField(fitted2[29]);

  const composite = fitted1.slice(5, 30) + dob + dob_cd + exp + exp_cd + fitted2.slice(18, 29);
  const checks = {
    document_number: checkDigit(doc) === Number(doc_cd),
    birth_date: checkDigit(dob) === Number(dob_cd) && /^\d{6}$/.test(dob),
    expiry_date: checkDigit(exp) === Number(exp_cd) && /^\d{6}$/.test(exp),
    composite: checkDigit(composite) === Number(comp_cd)
  };

  const allPassed = Object.values(checks).every(Boolean);
  if (!allPassed) return null;

  const parts = fitted3.replace(/<+$/, "").split("<<");
  const surname = (parts[0] || "").replace(/</g, " ").trim();
  const given = (parts.slice(1).join(" ") || "").replace(/</g, " ").trim();
  const fullName = given ? `${given} ${surname}`.trim() : surname;

  const natCode = fitted2.slice(15, 18).replace(/0/g, "O").replace(/1/g, "I");
  const countryCode = fitted1.slice(2, 5).replace(/0/g, "O").replace(/1/g, "I");

  return {
    format: "TD1",
    document_type: fitted1.slice(0, 2).replace(/</g, ""),
    issuing_country: countryCode,
    issuing_state: countryCode,
    surname,
    given_names: given,
    name: fullName,
    document_number: doc.replace(/</g, ""),
    passport_no: doc.replace(/</g, ""),
    nationality: NATIONALITY_LABELS[natCode] || natCode,
    nationality_code: natCode,
    birth_date: parseMrzDate(dob, { isDob: true, referenceDate: options.referenceDate }),
    dob: parseMrzDate(dob, { isDob: true, referenceDate: options.referenceDate }),
    sex: "MF".includes(fitted2[7]) ? fitted2[7] : "X",
    expiry_date: parseMrzDate(exp, { isDob: false, referenceDate: options.referenceDate }),
    passport_expiry: parseMrzDate(exp, { isDob: false, referenceDate: options.referenceDate }),
    optional_data: "",
    checks,
    all_checks_passed: true,
    rawLines: [fitted1, fitted2, fitted3]
  };
}

/**
 * Universal multi-format MRZ parser matching python try_parse(lines).
 * Tries TD3 (passports 2x44), TD1 (ID 3x30), and TD2 (ID 2x36).
 */
export function tryParseMrz(textOrLines, options = {}) {
  const lines = Array.isArray(textOrLines) ? textOrLines : cleanLines(textOrLines);
  if (!lines || lines.length < 2) return null;

  const specs = [
    { nLines: 2, size: 44, fn: parseTd3 },
    { nLines: 3, size: 30, fn: parseTd1 },
    { nLines: 2, size: 36, fn: parseTd2 }
  ];

  for (const { nLines, size, fn } of specs) {
    if (lines.length < nLines) continue;
    for (let i = 0; i <= lines.length - nLines; i += 1) {
      const slice = lines.slice(i, i + nLines);
      const fitted = slice.map(l => fit(l, size));
      if (fitted.some(x => x === null)) continue;
      const res = fn(...fitted, options);
      if (res && res.all_checks_passed) {
        return res;
      }
    }
  }
  return null;
}

/**
 * Multi-frame per-character majority voting and N-consecutive-frame consensus tracker.
 *
 * Accepts a live scan ONLY when:
 * 1. Every accepted frame passes all 5 ICAO check digits and strict TD3 validation.
 * 2. Per-character majority voting stabilizes Line 1 (unchecked name) and Line 2.
 * 3. `requiredFrames` (default N = 3) consecutive valid frames agree on the exact parsed identity.
 */
export class MrzFrameConsensus {
  constructor({ requiredFrames = 3, maxWindow = 7 } = {}) {
    this.requiredFrames = requiredFrames;
    this.maxWindow = maxWindow;
    this.reset();
  }

  reset() {
    this.frames = [];
    this.consecutiveMatches = 0;
    this.lastConsensusKey = null;
    this.missedStreak = 0;
  }

  /**
   * Compute per-character majority vote across buffered 44-char lines.
   */
  static majorityVoteLine(lines) {
    let out = "";
    for (let pos = 0; pos < 44; pos += 1) {
      const counts = new Map();
      let bestChar = lines[lines.length - 1][pos];
      let bestCount = 0;
      for (const line of lines) {
        const ch = line[pos];
        const next = (counts.get(ch) || 0) + 1;
        counts.set(ch, next);
        // On tie, prefer the most recent frame's character
        if (next >= bestCount) {
          bestCount = next;
          bestChar = ch;
        }
      }
      out += bestChar;
    }
    return out;
  }

  /**
   * Feed a new OCR text frame.
   * @returns {{ locked: boolean, validFrame: boolean, consecutive: number, required: number, data: object|null, errors: string[] }}
   */
  push(ocrText, options = {}) {
    let parsed = parseTd3Mrz(ocrText, options);
    if (!parsed.valid) {
      const alt = tryParseMrz(ocrText, options);
      if (alt && alt.all_checks_passed && alt.rawLines?.length === 2 && alt.rawLines[0].length === 44 && alt.rawLines[1].length === 44) {
        parsed = { valid: true, data: alt, rawLines: alt.rawLines, errors: [] };
      }
    }
    if (!parsed.valid) {
      this.missedStreak += 1;
      // Allow 1 momentary blur frame without wiping out progress; reset after 2 consecutive misses
      if (this.missedStreak >= 2) {
        this.consecutiveMatches = 0;
        this.lastConsensusKey = null;
      }
      return {
        locked: false,
        validFrame: false,
        consecutive: this.consecutiveMatches,
        required: this.requiredFrames,
        data: null,
        errors: parsed.errors
      };
    }

    this.missedStreak = 0;
    const [line1, line2] = parsed.rawLines;

    // If passport number changed completely (user swapped passports), reset buffer
    if (
      this.frames.length > 0 &&
      this.frames[this.frames.length - 1].passport_no !== parsed.data.passport_no
    ) {
      this.reset();
    }

    this.frames.push({
      line1,
      line2,
      passport_no: parsed.data.passport_no
    });
    if (this.frames.length > this.maxWindow) {
      this.frames.shift();
    }

    // Per-character majority voting across the buffered valid frames
    const votedLine1 = MrzFrameConsensus.majorityVoteLine(this.frames.map(f => f.line1));
    const votedLine2 = MrzFrameConsensus.majorityVoteLine(this.frames.map(f => f.line2));

    // Re-validate the voted consensus pair strictly!
    const consensus = validateTd3Pair(votedLine1, votedLine2, options);
    if (!consensus.valid) {
      this.consecutiveMatches = 0;
      this.lastConsensusKey = null;
      return {
        locked: false,
        validFrame: false,
        consecutive: 0,
        required: this.requiredFrames,
        data: null,
        errors: consensus.errors
      };
    }

    // Check consecutive agreement on key fields (including surname & given_names!)
    const key = [
      consensus.data.passport_no,
      consensus.data.dob,
      consensus.data.passport_expiry,
      consensus.data.surname,
      consensus.data.given_names
    ].join("|");

    if (key === this.lastConsensusKey) {
      this.consecutiveMatches += 1;
    } else {
      this.lastConsensusKey = key;
      this.consecutiveMatches = 1;
    }

    const locked = this.consecutiveMatches >= this.requiredFrames;
    return {
      locked,
      validFrame: true,
      consecutive: this.consecutiveMatches,
      required: this.requiredFrames,
      data: locked ? consensus.data : null,
      preview: consensus.data,
      errors: []
    };
  }
}

/**
 * Standard Levenshtein edit distance.
 */
export function levenshtein(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;

  const prev = new Uint16Array(t.length + 1);
  const curr = new Uint16Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;

  for (let i = 1; i <= s.length; i += 1) {
    curr[0] = i;
    const sc = s.charCodeAt(i - 1);
    for (let j = 1; j <= t.length; j += 1) {
      const cost = sc === t.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev.set(curr);
  }
  return prev[t.length];
}

/**
 * Normalize printed VIZ or MRZ name text for diacritic- and case-insensitive comparison.
 * Expands common ICAO transliterations (Ä->AE, Ö->OE, Ü->UE, ß->SS, Æ->AE, Ø->OE, Å->AA).
 */
export function normalizeForNameMatch(text) {
  return String(text || "")
    .replace(/Ä/g, "AE").replace(/ä/g, "AE")
    .replace(/Ö/g, "OE").replace(/ö/g, "OE")
    .replace(/Ü/g, "UE").replace(/ü/g, "UE")
    .replace(/ß/g, "SS")
    .replace(/Æ/g, "AE").replace(/æ/g, "AE")
    .replace(/Ø/g, "OE").replace(/ø/g, "OE")
    .replace(/Å/g, "AA").replace(/å/g, "AA")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/['’-]/g, " ")
    .replace(/[^A-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Cross-verify the MRZ-parsed name (which has no ICAO check digit) against OCR text
 * captured from the passport's Visual Inspection Zone (VIZ).
 *
 * @param {{ surname: string, given_names: string, name_truncated?: boolean }} mrzData
 * @param {string} vizText - Raw OCR text from the upper passport data page
 * @returns {{
 *   status: "verified" | "mismatch" | "unavailable",
 *   score: number,
 *   matchedTokens: string[],
 *   unmatchedTokens: string[],
 *   message: string
 * }}
 */
export function crossVerifyNameWithViz(mrzData, vizText) {
  const mrzSurnameTokens = normalizeForNameMatch(mrzData?.surname || "").split(" ").filter(Boolean);
  const mrzGivenTokens = normalizeForNameMatch(mrzData?.given_names || "").split(" ").filter(Boolean);
  const allMrzTokens = [...mrzSurnameTokens, ...mrzGivenTokens];

  if (!allMrzTokens.length) {
    return {
      status: "mismatch",
      score: 0,
      matchedTokens: [],
      unmatchedTokens: [],
      message: "MRZ name is empty."
    };
  }

  const normalizedViz = normalizeForNameMatch(vizText || "");
  const vizTokens = normalizedViz.split(" ").filter(t => t.length >= 1);

  if (vizTokens.length < 1 || normalizedViz.replace(/\s/g, "").length < 3) {
    return {
      status: "unavailable",
      score: 0,
      matchedTokens: [],
      unmatchedTokens: allMrzTokens,
      message: "Printed name zone (VIZ) was not readable. Confirm name carefully against the passport."
    };
  }

  const matchedTokens = [];
  const unmatchedTokens = [];
  let totalSim = 0;

  for (let i = 0; i < allMrzTokens.length; i += 1) {
    const token = allMrzTokens[i];
    const isLastTruncatedToken = Boolean(mrzData?.name_truncated) && i === allMrzTokens.length - 1;
    let bestSim = 0;

    for (const vt of vizTokens) {
      let sim = tokenSimilarity(token, vt);
      // If MRZ was truncated at 39 chars, allow prefix match on the last token (e.g. "SHAHIDU" vs "SHAHIDUL")
      if (isLastTruncatedToken && vt.length > token.length && vt.startsWith(token.slice(0, Math.max(3, token.length - 1)))) {
        sim = Math.max(sim, tokenSimilarity(token, vt.slice(0, token.length)));
      }
      if (sim > bestSim) bestSim = sim;
    }

    // Also test adjacent joined VIZ tokens (in case VIZ split a word or MRZ omitted space)
    for (let j = 0; j < vizTokens.length - 1; j += 1) {
      const joined = vizTokens[j] + vizTokens[j + 1];
      const sim = tokenSimilarity(token, joined);
      if (sim > bestSim) bestSim = sim;
    }

    totalSim += bestSim;
    // Allow 1 edit on tokens >= 5 chars (sim >= 0.8), exact match on short tokens <= 3 chars
    const threshold = token.length <= 3 ? 0.99 : token.length === 4 ? 0.75 : 0.80;
    if (bestSim >= threshold) {
      matchedTokens.push(token);
    } else {
      unmatchedTokens.push(token);
    }
  }

  const avgScore = Number((totalSim / allMrzTokens.length).toFixed(3));
  const verified = unmatchedTokens.length === 0 && avgScore >= 0.82;

  if (verified) {
    return {
      status: "verified",
      score: avgScore,
      matchedTokens,
      unmatchedTokens: [],
      message: `Name verified against printed passport page (${Math.round(avgScore * 100)}% match).`
    };
  }

  return {
    status: "mismatch",
    score: avgScore,
    matchedTokens,
    unmatchedTokens,
    message: `Name mismatch with printed page (${unmatchedTokens.join(", ")}). Rescan or manually confirm.`
  };
}
