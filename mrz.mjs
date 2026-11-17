const WEIGHTS = [7, 3, 1];

export function checkDigit(value) {
  let total = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    const number = c === "<" ? 0 : c >= "0" && c <= "9" ? Number(c) : c >= "A" && c <= "Z" ? c.charCodeAt(0) - 55 : 0;
    total += number * WEIGHTS[i % 3];
  }
  return total % 10;
}

function digits(value) {
  return String(value || "")
    .replace(/[OQD]/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/B/g, "8")
    .replace(/S/g, "5")
    .replace(/Z/g, "2")
    .replace(/G/g, "6");
}

function letters(value) {
  return String(value || "")
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/8/g, "B")
    .replace(/5/g, "S")
    .replace(/2/g, "Z");
}

const COUNTRY_MAP = {
  BGD: "Bangladeshi",
  MYS: "Malaysian",
  IND: "Indian",
  PAK: "Pakistani",
  NPL: "Nepali",
  IDN: "Indonesian",
  MMR: "Myanmar",
  PHL: "Filipino",
  VNM: "Vietnamese",
  LKA: "Sri Lankan"
};

function dateFromMrz(value, isDob) {
  if (!/^\d{6}$/.test(value)) return null;
  const yy = Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const currentYear = new Date().getFullYear();
  let year;
  if (isDob) {
    const thisCentury = Math.floor(currentYear / 100) * 100 + yy;
    year = thisCentury > currentYear ? thisCentury - 100 : thisCentury;
    if (year < currentYear - 110) year += 100;
    // Worker age sanity check (under 100, not in the future)
    if (year > currentYear || year < currentYear - 100) return null;
  } else {
    year = Math.floor(currentYear / 100) * 100 + yy;
    if (year < currentYear - 20) year += 100;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// TD3: Standard Passport Format (2 lines x 44 chars)
function parseTD3(first, second) {
  if (!first.startsWith("P")) return null;
  const line1 = first.slice(0, 44).padEnd(44, "<");
  const line2 = second.slice(0, 44).padEnd(44, "<");

  let passport = line2.slice(0, 9);
  const passportDigit = Number(digits(line2[9]));
  if (checkDigit(passport) !== passportDigit) {
    const corrected = passport[0] + digits(passport.slice(1));
    if (checkDigit(corrected) === passportDigit) passport = corrected;
  }

  const dobDigits = digits(line2.slice(13, 19));
  const expiryDigits = digits(line2.slice(21, 27));

  const checks = {
    passport: checkDigit(passport) === passportDigit,
    dob: checkDigit(dobDigits) === Number(digits(line2[19])),
    expiry: checkDigit(expiryDigits) === Number(digits(line2[27]))
  };

  // Composite check digit over positions 0-9, 13-19, 21-42 of line 2
  const compositeSource = `${line2.slice(0, 10)}${dobDigits}${digits(line2[19])}${expiryDigits}${digits(line2[27])}${line2.slice(28, 43)}`;
  const compositeDigit = Number(digits(line2[43]));
  const compositeMatch = !isNaN(compositeDigit) && checkDigit(compositeSource) === compositeDigit;
  if (!isNaN(compositeDigit) && line2[43] !== "<") {
    checks.composite = compositeMatch;
  }

  const [surname = "", ...givenNames] = line1.slice(5).split("<<");
  const name = `${letters(givenNames.join(" ")).replace(/</g, " ").replace(/\s+/g, " ").trim()} ${letters(surname).replace(/</g, " ").trim()}`.trim();
  const nationalityCode = letters(line2.slice(10, 13).replace(/</g, ""));
  const nationality = COUNTRY_MAP[nationalityCode] || (nationalityCode === "BGD" ? "Bangladeshi" : nationalityCode);

  const score = [checks.passport, checks.dob, checks.expiry].filter(Boolean).length;

  return {
    format: "TD3",
    name,
    passport_no: passport.replace(/</g, ""),
    dob: dateFromMrz(dobDigits, true),
    passport_expiry: dateFromMrz(expiryDigits, false),
    sex: ["M", "F"].includes(line2[20]) ? line2[20] : null,
    nationality,
    checks,
    score
  };
}

// TD1: 3-line ID card format (3 lines x 30 chars)
function parseTD1(line1, line2, line3) {
  if (!line1 || !line2 || !line3) return null;
  const l1 = line1.slice(0, 30).padEnd(30, "<");
  const l2 = line2.slice(0, 30).padEnd(30, "<");
  const l3 = line3.slice(0, 30).padEnd(30, "<");

  if (!["I", "A", "C"].includes(l1[0])) return null;

  let docNo = l1.slice(5, 14);
  const docDigit = Number(digits(l1[14]));
  if (checkDigit(docNo) !== docDigit) {
    const corrected = docNo[0] + digits(docNo.slice(1));
    if (checkDigit(corrected) === docDigit) docNo = corrected;
  }

  const dobDigits = digits(l2.slice(0, 6));
  const expiryDigits = digits(l2.slice(8, 14));

  const checks = {
    passport: checkDigit(docNo) === docDigit,
    dob: checkDigit(dobDigits) === Number(digits(l2[6])),
    expiry: checkDigit(expiryDigits) === Number(digits(l2[14]))
  };

  const [surname = "", ...givenNames] = l3.split("<<");
  const name = `${letters(givenNames.join(" ")).replace(/</g, " ").replace(/\s+/g, " ").trim()} ${letters(surname).replace(/</g, " ").trim()}`.trim();
  const nationalityCode = letters(l2.slice(15, 18).replace(/</g, ""));
  const nationality = COUNTRY_MAP[nationalityCode] || nationalityCode;

  const score = [checks.passport, checks.dob, checks.expiry].filter(Boolean).length;

  return {
    format: "TD1",
    name,
    passport_no: docNo.replace(/</g, ""),
    dob: dateFromMrz(dobDigits, true),
    passport_expiry: dateFromMrz(expiryDigits, false),
    sex: ["M", "F"].includes(l2[7]) ? l2[7] : null,
    nationality,
    checks,
    score
  };
}

export function parseMrz(text) {
  if (!text) return null;
  const lines = String(text)
    .toUpperCase()
    .split(/\r?\n/)
    .map(line => line.replace(/[^A-Z0-9<]/g, ""))
    .filter(line => line.length >= 26);

  if (lines.length < 2) return null;

  let best = null;

  // Try TD3 first (2 lines of 44 chars)
  for (let i = 0; i < lines.length - 1; i += 1) {
    const result = parseTD3(lines[i], lines[i + 1]);
    if (result && (!best || result.score > best.score)) {
      best = result;
      if (best.score === 3) break;
    }
  }

  // Try TD1 if no valid TD3 found (3 lines of 30 chars)
  if (!best || best.score < 2) {
    for (let i = 0; i < lines.length - 2; i += 1) {
      const result = parseTD1(lines[i], lines[i + 1], lines[i + 2]);
      if (result && (!best || result.score > best.score)) {
        best = result;
        if (best.score === 3) break;
      }
    }
  }

  return best;
}
