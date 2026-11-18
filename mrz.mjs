/**
 * ICAO Doc 9303 Part 4 — TD3 Passport MRZ Parser, Validator & Robust Line Recovery
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

export const VALID_ICAO_COUNTRY_CODES = new Set([
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
  "D<<", "GBD", "GBN", "GBO", "GBP", "GBS", "UNO", "UNA", "UNK", "RKS", "EUE", "XBA", "XIM", "XCC", "XCE", "XCO", "XEC", "XPO", "XOM", "XXA", "XXB", "XXC", "XXX", "UTO"
]);

export const NATIONALITY_LABELS = {
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

export function checkDigit(value) {
  if (value === null || value === undefined) return -1;
  const str = String(value);
  let total = 0;
  for (let i = 0; i < str.length; i += 1) {
    const c = str[i];
    let num = 0;
    if (c === "<") {
      num = 0;
    } else if (c >= "0" && c <= "9") {
      num = c.charCodeAt(0) - 48;
    } else if (c >= "A" && c <= "Z") {
      num = c.charCodeAt(0) - 55;
    } else {
      return -1;
    }
    total += num * WEIGHTS[i % 3];
  }
  return total % 10;
}

export function toNumericField(value) {
  return String(value || "")
    .replace(/[OQD]/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/B/g, "8")
    .replace(/S/g, "5")
    .replace(/Z/g, "2")
    .replace(/G/g, "6");
}

export function toAlphaField(value) {
  return String(value || "")
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/2/g, "Z")
    .replace(/4/g, "A")
    .replace(/5/g, "S")
    .replace(/6/g, "G")
    .replace(/8/g, "B");
}

export function repairNameOcrConfusions(rawName39) {
  if (typeof rawName39 !== "string") return "";
  return toAlphaField(rawName39);
}

export function repairIcaoCountryCode(raw3) {
  if (typeof raw3 !== "string" || raw3.length !== 3) return null;
  if (VALID_ICAO_COUNTRY_CODES.has(raw3)) return raw3;

  const fixed = toAlphaField(raw3);
  if (VALID_ICAO_COUNTRY_CODES.has(fixed)) return fixed;

  if (raw3.includes("6")) {
    const altB = fixed.replace(/G/g, "B");
    if (VALID_ICAO_COUNTRY_CODES.has(altB)) return altB;
    const altFirstB = raw3.replace(/^6/, "B").replace(/0/g, "O").replace(/1/g, "I").replace(/8/g, "B");
    if (VALID_ICAO_COUNTRY_CODES.has(altFirstB)) return altFirstB;
  }
  if (raw3.includes("0")) {
    const altD = raw3.replace(/0/g, "D").replace(/1/g, "I").replace(/6/g, "G").replace(/8/g, "B");
    if (VALID_ICAO_COUNTRY_CODES.has(altD)) return altD;
  }
  return null;
}

export function isValidIcaoCountryCode(code) {
  if (typeof code !== "string" || code.length !== 3) return false;
  return VALID_ICAO_COUNTRY_CODES.has(code);
}

export function parseMrzDate(yymmdd, { isDob = false, referenceDate = new Date(), dobIso = null } = {}) {
  const clean = toNumericField(yymmdd);
  if (!/^\d{6}$/.test(clean)) return null;
  const yy = Number(clean.slice(0, 2));
  const month = Number(clean.slice(2, 4));
  const day = Number(clean.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const refYear = referenceDate.getUTCFullYear();
  const refMonth = referenceDate.getUTCMonth() + 1;
  const refDay = referenceDate.getUTCDate();
  const centuryBase = Math.floor(refYear / 100) * 100;

  let year = centuryBase + yy;
  if (isDob) {
    const isFuture =
      year > refYear ||
      (year === refYear && month > refMonth) ||
      (year === refYear && month === refMonth && day > refDay);
    if (isFuture) year -= 100;
    if (refYear - year > 125) return null;
  } else {
    if (year > refYear + 50) year -= 100;
    else if (year < refYear - 30) year += 100;
  }

  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }

  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!isDob && dobIso && iso <= dobIso) return null;
  return iso;
}

export function cleanTd3NameFillerNoise(raw39) {
  let s = repairNameOcrConfusions(raw39);

  const tripleIdx = s.indexOf("<<<");
  if (tripleIdx !== -1) {
    s = s.slice(0, tripleIdx) + "<".repeat(39 - tripleIdx);
  }

  const firstSep = s.indexOf("<<");
  if (firstSep !== -1) {
    const secondSep = s.indexOf("<<", firstSep + 2);
    if (secondSep !== -1) {
      s = s.slice(0, secondSep) + "<".repeat(39 - secondSep);
    }
  }

  let prev;
  do {
    prev = s;
    const trimmedLen = s.replace(/<+$/, "").length;
    const head = s.slice(0, trimmedLen);
    const trailingFillers = 39 - trimmedLen;

    const identicalRunMatch = head.match(/([KCLSEI])\1{2,}$/);
    if (identicalRunMatch) {
      const runLen = identicalRunMatch[0].length;
      const runStart = head.length - runLen;
      if (trailingFillers > 0 || runStart + runLen === 39) {
        s = head.slice(0, runStart) + "<".repeat(39 - runStart);
        continue;
      }
    }

    const alternatingMatch = head.match(/(?:<+[KCLSEI]{1,2}){3,}$/);
    if (alternatingMatch) {
      const matchStart = head.length - alternatingMatch[0].length;
      s = head.slice(0, matchStart) + "<".repeat(39 - matchStart);
      continue;
    }

    if (trailingFillers >= 1) {
      const doubleKMatch = head.match(/<K{2,}$/);
      if (doubleKMatch) {
        const matchStart = head.length - doubleKMatch[0].length;
        s = head.slice(0, matchStart) + "<".repeat(39 - matchStart);
        continue;
      }
    }

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

export function parseTd3Name(line1) {
  if (typeof line1 !== "string" || line1.length !== 44) {
    return { valid: false, error: "TD3 Line 1 must be exactly 44 characters." };
  }

  const rawNameField = line1.slice(5, 44);
  const repaired39 = repairNameOcrConfusions(rawNameField);

  if (/[0-9]/.test(repaired39)) {
    return { valid: false, error: "MRZ name field contains invalid digit(s). Rescan required." };
  }
  if (!/^[A-Z<]{39}$/.test(repaired39)) {
    return { valid: false, error: "MRZ name field contains invalid characters." };
  }

  const cleaned39 = cleanTd3NameFillerNoise(repaired39);
  const truncated = !cleaned39.endsWith("<");
  let content = cleaned39.replace(/<+$/, "");

  if (!content.includes("<<")) {
    if (/^(?:<K|K<|KK)/.test(content)) {
      content = content.replace(/^(?:<K|K<|KK)/, "<<");
    } else {
      content = content.replace(/([A-Z])(?:<K|K<|KK)([A-Z])/g, (m, p1, p2) => `${p1}<<${p2}`);
    }
  }

  const sepIndex = content.indexOf("<<");
  let surnameRaw = "";
  let givenRaw = "";

  if (sepIndex === -1) {
    surnameRaw = content;
    givenRaw = "";
  } else if (sepIndex === 0) {
    surnameRaw = "";
    givenRaw = content.slice(2);
  } else {
    surnameRaw = content.slice(0, sepIndex);
    const afterSep = content.slice(sepIndex + 2);
    if (afterSep.startsWith("<")) {
      givenRaw = "";
    } else {
      givenRaw = afterSep;
    }
  }

  const surname = surnameRaw.replace(/</g, " ").replace(/\s+/g, " ").trim();
  const given_names = givenRaw.replace(/</g, " ").replace(/\s+/g, " ").trim();

  if (!surname && !given_names) {
    return { valid: false, error: "Neither surname nor given names could be extracted from MRZ Line 1." };
  }

  const full_name = (given_names && surname) ? `${given_names} ${surname}`.trim() : (surname || given_names);

  return {
    valid: true,
    surname,
    given_names,
    full_name,
    name: full_name,
    truncated,
    cleaned_raw: cleaned39,
    error: null
  };
}

function parseCheckDigitChar(ch, allowFillerZero = false) {
  if (allowFillerZero && ch === "<") return 0;
  const fixed = toNumericField(ch);
  if (!/^[0-9]$/.test(fixed)) return null;
  return Number(fixed);
}

function repairNumericPositionsWithCheck(rawField, expectedDigit) {
  if (checkDigit(rawField) === expectedDigit) {
    return { value: rawField, repaired: false, valid: true };
  }

  for (const prefixLen of [2, 1, 0]) {
    const candidate = rawField.slice(0, prefixLen) + toNumericField(rawField.slice(prefixLen));
    if (candidate !== rawField && checkDigit(candidate) === expectedDigit) {
      return { value: candidate, repaired: true, valid: true };
    }
  }

  const swaps = {
    O: ["0", "D"], "0": ["O", "D"],
    D: ["0", "O"], Q: ["0"],
    I: ["1", "L"], "1": ["I", "L"],
    L: ["1", "I"],
    B: ["8"], "8": ["B"],
    S: ["5"], "5": ["S"],
    Z: ["2"], "2": ["Z"],
    G: ["6", "C"], "6": ["G"],
    C: ["G", "E", "0"], E: ["F", "C"],
    "9": ["5", "8"], "3": ["8"]
  };
  const validCandidates = [];
  for (let i = 0; i < rawField.length; i += 1) {
    const alts = swaps[rawField[i]];
    if (!alts) continue;
    for (const alt of alts) {
      const cand = rawField.slice(0, i) + alt + rawField.slice(i + 1);
      if (checkDigit(cand) === expectedDigit) {
        validCandidates.push(cand);
      }
    }
  }
  if (validCandidates.length === 1) {
    return { value: validCandidates[0], repaired: true, valid: true };
  }

  return { value: rawField, repaired: false, valid: false };
}

export function cleanOcrLine(rawLine) {
  return String(rawLine || "")
    .toUpperCase()
    .replace(/[«‹⟨≤≥⟩›»([{)\]}\>]/g, "<")
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9<]/g, "");
}

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

  checks.documentType = line1[0] === "P" && /^[A-Z<]$/.test(line1[1]);
  if (!checks.documentType) {
    errors.push(`Invalid TD3 passport document code "${line1.slice(0, 2)}" (must start with "P").`);
  }

  let issuingState = line1.slice(2, 5);
  if (!isValidIcaoCountryCode(issuingState)) {
    const repState = repairIcaoCountryCode(issuingState);
    if (repState) issuingState = repState;
  }
  checks.issuingState = isValidIcaoCountryCode(issuingState);
  if (!checks.issuingState) {
    errors.push(`Invalid issuing state code "${issuingState}".`);
  }

  const parsedName = parseTd3Name(line1);
  checks.name = parsedName.valid;
  if (!parsedName.valid) {
    errors.push(parsedName.error);
  }

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

  let nationalityCode = line2.slice(10, 13);
  if (!isValidIcaoCountryCode(nationalityCode)) {
    const repNat = repairIcaoCountryCode(nationalityCode);
    if (repNat) nationalityCode = repNat;
  }
  checks.nationality = isValidIcaoCountryCode(nationalityCode);
  if (!checks.nationality) {
    errors.push(`Invalid nationality code "${nationalityCode}".`);
  }

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

  const sexRaw = line2[20];
  checks.sex = sexRaw === "M" || sexRaw === "F" || sexRaw === "<";
  if (!checks.sex) {
    errors.push(`Invalid sex indicator "${sexRaw}" (must be M, F, or <).`);
  }

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
    issuing_country: issuingState === "D<<" ? "D" : issuingState,
    surname: parsedName.surname,
    given_names: parsedName.given_names,
    name: parsedName.full_name,
    name_truncated: parsedName.truncated,
    passport_no: verifiedPassport.replace(/</g, ""),
    document_number: verifiedPassport.replace(/</g, ""),
    nationality_code: nationalityCode === "D<<" ? "D" : nationalityCode,
    nationality: NATIONALITY_LABELS[nationalityCode] || (nationalityCode === "D<<" ? "German" : nationalityCode),
    dob: dobIso,
    birth_date: dobIso,
    sex: sexRaw === "<" ? null : sexRaw,
    sex_raw: sexRaw,
    gender: sexRaw === "M" ? "Male" : sexRaw === "F" ? "Female" : "Unspecified",
    passport_expiry: expiryIso,
    expiry_date: expiryIso,
    personal_number: verifiedPersonal.replace(/</g, "") || null,
    optional_data: verifiedPersonal.replace(/</g, "") || "",
    mrz_line1: normalizedLine1,
    mrz_line2: normalizedLine2,
    checks,
    all_checks_passed: true
  };

  return { valid: true, errors: [], checks, data, rawLines: [normalizedLine1, normalizedLine2] };
}

export function parseTd3Mrz(text, options = {}) {
  const lines = cleanLines(text);
  if (lines.length === 2) {
    return validateTd3Pair(lines[0], lines[1], options);
  }
  if (lines.length > 2) {
    for (let i = 0; i <= lines.length - 2; i += 1) {
      const res = validateTd3Pair(lines[i], lines[i + 1], options);
      if (res.valid) return res;
    }
  }
  return { valid: false, errors: ["Could not find valid TD3 MRZ lines."], checks: {}, data: null };
}

export function parseMrz(text, options = {}) {
  const lines = cleanLines(text);
  if (lines.length !== 2 || lines[0].length !== 44 || lines[1].length !== 44) {
    return null;
  }
  const res = validateTd3Pair(lines[0], lines[1], options);
  return res.valid ? res.data : null;
}

export function fit(line, n) {
  if (!line || typeof line !== "string") return null;
  if (Math.abs(line.length - n) > 2) return null;
  return (line + "<".repeat(n)).slice(0, n);
}

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

export function extractTd3Mrz(text, options = {}) {
  if (!text || typeof text !== "string") {
    return { valid: false, errors: ["No text provided"], checks: {}, data: null };
  }

  const rawLines = text.split(/\r?\n/).map(cleanOcrLine).filter(l => l.length >= 26);
  if (!rawLines.length) {
    return { valid: false, errors: ["No candidate MRZ lines detected."], checks: {}, data: null };
  }

  // Helper to test a pair of candidate strings with possible length corrections
  const tryPair = (l1Candidate, l2Candidate) => {
    // 1. Direct validation if both 44
    if (l1Candidate.length === 44 && l2Candidate.length === 44) {
      const res = validateTd3Pair(l1Candidate, l2Candidate, options);
      if (res.valid) return res;
    }

    // 2. Try fit(44)
    const f1 = fit(l1Candidate, 44);
    const f2 = fit(l2Candidate, 44);
    if (f1 && f2) {
      const res = validateTd3Pair(f1, f2, options);
      if (res.valid) return res;
    }

    // 3. Handle single-character OCR insertions (e.g. line length is 45)
    if (l2Candidate.length === 45) {
      let bestHit = null;
      for (let idx = 44; idx >= 0; idx -= 1) {
        if (l2Candidate[idx] === "<") continue;
        const cand2 = l2Candidate.slice(0, idx) + l2Candidate.slice(idx + 1);
        const res = validateTd3Pair(f1 || l1Candidate, cand2, options);
        if (res.valid) {
          const persRaw = cand2.slice(28, 42);
          const cd = parseCheckDigitChar(cand2[42], /^<+$/.test(persRaw));
          if (cd !== null && checkDigit(persRaw) === cd) {
            return res;
          }
          if (!bestHit) bestHit = res;
        }
      }
      if (bestHit) return bestHit;
    }

    if (l1Candidate.length === 45) {
      for (let idx = 44; idx >= 0; idx -= 1) {
        if (l1Candidate[idx] === "<") continue;
        const cand1 = l1Candidate.slice(0, idx) + l1Candidate.slice(idx + 1);
        const res = validateTd3Pair(cand1, f2 || l2Candidate, options);
        if (res.valid) return res;
      }
    }
    return null;
  };

  // Phase 1: Try pairs of adjacent or nearby lines directly
  for (let i = 0; i < rawLines.length; i += 1) {
    const l1 = rawLines[i];
    for (let j = i + 1; j < Math.min(rawLines.length, i + 3); j += 1) {
      const l2 = rawLines[j];
      const res = tryPair(l1, l2);
      if (res) return res;
    }
  }

  // Phase 2a: Exact 44-char substring match (zero deletions/alterations)
  for (const raw1 of rawLines) {
    const pIdx = raw1.indexOf("P<");
    if (pIdx === -1 || raw1.length < pIdx + 44) continue;
    const sub1 = raw1.slice(pIdx, pIdx + 44);

    for (const raw2 of rawLines) {
      if (raw2 === raw1) continue;
      for (let offset = 0; offset <= raw2.length - 44; offset += 1) {
        const sub2 = raw2.slice(offset, offset + 44);
        const res = validateTd3Pair(sub1, sub2, options);
        if (res.valid) return res;
      }
    }
  }

  // Phase 2b: Sliding window substring search with ±1 char insertion/deletion recovery
  let bestPairRes = null;
  for (const raw1 of rawLines) {
    // Search for P< or 0< or country patterns
    let base1 = raw1;
    if (base1.startsWith("0<")) base1 = "P<" + base1.slice(2);
    if (base1.length < 44 && base1.length >= 28 && base1.startsWith("P<")) {
      base1 = base1.padEnd(44, "<");
    }

    let pIdx = base1.indexOf("P<");
    if (pIdx === -1) {
      const match = base1.match(/P[A-Z<]/);
      if (match) pIdx = match.index;
    }
    if (pIdx === -1) continue;

    for (let len1 of [44, 45, 43]) {
      if (pIdx + len1 > base1.length + 2) continue;
      const sub1 = base1.slice(pIdx, pIdx + len1);

      for (const raw2 of rawLines) {
        if (raw2 === raw1) continue;
        for (let offset = 0; offset <= Math.max(0, raw2.length - 42); offset += 1) {
          for (let len2 of [44, 45, 43]) {
            if (offset + len2 > raw2.length + 2) continue;
            const sub2 = raw2.slice(offset, offset + len2);
            const res = tryPair(sub1, sub2);
            if (res) {
              const rawDoc = sub2.slice(0, 9);
              if (checkDigit(rawDoc) === Number(sub2[9])) {
                return res;
              }
              if (!bestPairRes) bestPairRes = res;
            }
          }
        }
      }
    }
  }
  if (bestPairRes) return bestPairRes;

  // Phase 3: Fall back to tryParseMrz for TD3 recovery
  const td3Fallback = tryParseMrz(rawLines, options);
  if (td3Fallback && td3Fallback.format === "TD3" && td3Fallback.all_checks_passed) {
    return {
      valid: true,
      errors: [],
      checks: td3Fallback.checks,
      data: td3Fallback,
      rawLines: td3Fallback.rawLines
    };
  }

  return { valid: false, errors: ["No valid TD3 passport MRZ could be verified."], checks: {}, data: null };
}

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
        if (next >= bestCount) {
          bestCount = next;
          bestChar = ch;
        }
      }
      out += bestChar;
    }
    return out;
  }

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
        errors: parsed.errors || ["MRZ validation failed."]
      };
    }

    this.missedStreak = 0;
    this.frames.push(parsed.rawLines);
    if (this.frames.length > this.maxWindow) this.frames.shift();

    const line1Votes = this.frames.map(f => f[0]);
    const line2Votes = this.frames.map(f => f[1]);
    const votedL1 = MrzFrameConsensus.majorityVoteLine(line1Votes);
    const votedL2 = MrzFrameConsensus.majorityVoteLine(line2Votes);

    const validated = validateTd3Pair(votedL1, votedL2, options);
    if (!validated.valid || !validated.data) {
      return {
        locked: false,
        validFrame: true,
        consecutive: this.consecutiveMatches,
        required: this.requiredFrames,
        data: null,
        errors: validated.errors
      };
    }

    const consensusKey = `${validated.data.passport_no}:${validated.data.dob}:${validated.data.name}`;
    if (consensusKey === this.lastConsensusKey) {
      this.consecutiveMatches += 1;
    } else {
      this.lastConsensusKey = consensusKey;
      this.consecutiveMatches = 1;
    }

    const locked = this.consecutiveMatches >= this.requiredFrames;
    return {
      locked,
      validFrame: true,
      consecutive: this.consecutiveMatches,
      required: this.requiredFrames,
      data: locked ? validated.data : null,
      errors: []
    };
  }
}

function normalizeForNameMatch(str) {
  return String(str || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const temp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }
  return row[n];
}

function tokenSimilarity(tok1, tok2) {
  if (tok1 === tok2) return 1;
  const maxLen = Math.max(tok1.length, tok2.length);
  if (maxLen === 0) return 1;
  const dist = levenshteinDistance(tok1, tok2);
  return 1 - dist / maxLen;
}

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
      if (isLastTruncatedToken && vt.length > token.length && vt.startsWith(token.slice(0, Math.max(3, token.length - 1)))) {
        sim = Math.max(sim, tokenSimilarity(token, vt.slice(0, token.length)));
      }
      if (sim > bestSim) bestSim = sim;
    }

    for (let j = 0; j < vizTokens.length - 1; j += 1) {
      const joined = vizTokens[j] + vizTokens[j + 1];
      const sim = tokenSimilarity(token, joined);
      if (sim > bestSim) bestSim = sim;
    }

    totalSim += bestSim;
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
