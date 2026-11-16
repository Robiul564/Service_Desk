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
  return value.replace(/[OQD]/g, "0").replace(/[IL]/g, "1").replace(/B/g, "8").replace(/S/g, "5").replace(/Z/g, "2").replace(/G/g, "6");
}

function letters(value) {
  return value.replace(/0/g, "O").replace(/1/g, "I").replace(/8/g, "B").replace(/5/g, "S").replace(/2/g, "Z");
}

function dateFromMrz(value, dateOfBirth) {
  if (!/^\d{6}$/.test(value)) return null;
  const yy = Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const currentYear = new Date().getFullYear();
  let year;
  if (dateOfBirth) {
    const thisCentury = Math.floor(currentYear / 100) * 100 + yy;
    year = thisCentury > currentYear ? thisCentury - 100 : thisCentury;
    if (year < currentYear - 110) year += 100;
  } else {
    year = Math.floor(currentYear / 100) * 100 + yy;
    if (year < currentYear - 20) year += 100;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parsePair(first, second) {
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
  const [surname = "", ...givenNames] = line1.slice(5).split("<<");
  const name = `${letters(givenNames.join(" ")).replace(/</g, " ").replace(/\s+/g, " ").trim()} ${letters(surname).replace(/</g, " ").trim()}`.trim();
  const nationalityCode = letters(line2.slice(10, 13).replace(/</g, ""));
  return {
    name,
    passport_no: passport.replace(/</g, ""),
    dob: dateFromMrz(dobDigits, true),
    passport_expiry: dateFromMrz(expiryDigits, false),
    sex: ["M", "F"].includes(line2[20]) ? line2[20] : null,
    nationality: nationalityCode === "BGD" ? "Bangladeshi" : nationalityCode,
    checks,
    score: Object.values(checks).filter(Boolean).length
  };
}

export function parseMrz(text) {
  const lines = String(text).toUpperCase().split(/\r?\n/).map(line => line.replace(/[^A-Z0-9<]/g, "")).filter(line => line.length >= 28);
  let best = null;
  for (let i = 0; i < lines.length - 1; i += 1) {
    const result = parsePair(lines[i], lines[i + 1]);
    if (result && (!best || result.score > best.score)) best = result;
  }
  return best;
}
